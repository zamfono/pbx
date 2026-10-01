/**
 * The Target-menu step's DTMF collection (§10.1 step 6) for `menu.ts`: the greeting with barge-in,
 * the first-digit and inter-digit timers, and `menuStep` deciding when a typed string
 * resolves.
 */
import { MS_PER_SECOND } from '@zamfono/shared';

import type { AriClient } from '../ari/client.js';
import type { AriEvent, Channel } from '../ari/types.js';
import {
  INTER_DIGIT_TIMEOUT_MS,
  menuStep,
  type MenuMap
} from '../routing/menu.js';
import { isChannelGone } from './playback.js';

export type CollectResult =
  | { kind: 'match'; targetId: string; typed: string }
  | { kind: 'unmatched'; typed: string }
  | { kind: 'hangup' };

/** What the string typed so far resolves to once collection ends, `timedOut` or not. */
function resultOf(
  map: MenuMap,
  typed: string,
  timedOut: boolean
): CollectResult {
  const step = menuStep(map, typed, timedOut);
  return step.kind === 'match'
    ? { kind: 'match', targetId: step.targetId, typed }
    : { kind: 'unmatched', typed };
}

/** Whether `typed` keeps collecting: `map` still waits on it, or, once `map` has given up on it,
 * it still prefixes a longer live extension (§10.1 step 6). */
function keepsCollecting(
  map: MenuMap,
  typed: string,
  extensionPrefixes: string[]
): boolean {
  const step = menuStep(map, typed, false);
  if (step.kind === 'wait') {
    return true;
  }
  return (
    step.kind === 'nomatch' &&
    extensionPrefixes.some(
      ext => ext.length > typed.length && ext.startsWith(typed)
    )
  );
}

/**
 * Plays the greeting on `channelId` and collects DTMF against `map`: a digit arriving while the
 * greeting still plays stops it and barges in, as a menu allows; otherwise the `timeout_s` silence
 * timer starts only once the greeting has actually finished (§10.1 step 6), or at once when the
 * play request is refused, since no `PlaybackFinished` then follows. The caller hanging up ends
 * the collection as `hangup`, never as silence. A string `map` has given up on (no mapped entry
 * extends it) still keeps collecting while it prefixes one of `extensionPrefixes`, so extension
 * dialling reaches extensions longer than one digit. Listens on the `AriClient`'s own event
 * stream directly, alongside (and independently of) the pipeline's own event routing, so a
 * menu's collection needs no dispatch wiring of its own.
 */
export function collectMenuInput(
  ari: AriClient,
  greeting: { channelId: string; media: string; playbackId: string },
  map: MenuMap,
  firstDigitTimeoutS: number,
  extensionPrefixes: string[]
): Promise<CollectResult> {
  const { channelId, media, playbackId } = greeting;
  return new Promise(resolve => {
    let typed = '';
    let greetingPlaying = true;
    // eslint-disable-next-line init-declarations -- assigned by armTimer before any event can fire
    let timer: ReturnType<typeof setTimeout>;
    const settle = (result: CollectResult): void => {
      // eslint-disable-next-line no-use-before-define -- settle and onEvent reference each other; onEvent is declared below
      ari.off('event', onEvent);
      clearTimeout(timer);
      resolve(result);
    };
    const armTimer = (): void => {
      clearTimeout(timer);
      const ms =
        typed === ''
          ? firstDigitTimeoutS * MS_PER_SECOND
          : INTER_DIGIT_TIMEOUT_MS;
      timer = setTimeout(() => {
        settle(resultOf(map, typed, true));
      }, ms);
      timer.unref();
    };
    // The greeting is over, played out or never started: the silence counts from here.
    const greetingEnded = (): void => {
      if (greetingPlaying) {
        greetingPlaying = false;
        armTimer();
      }
    };
    function onEvent(ev: AriEvent): void {
      if (ev.type === 'PlaybackFinished') {
        const playback = ev.playback as { id?: string } | undefined;
        if (playback?.id === playbackId) {
          greetingEnded();
        }
        return;
      }
      const channel = ev.channel as Channel | undefined;
      if (channel?.id !== channelId) {
        return;
      }
      if (ev.type === 'ChannelDtmfReceived') {
        if (greetingPlaying) {
          greetingPlaying = false;
          ari.playbacks.stop(playbackId).catch(() => undefined);
        }
        typed += typeof ev.digit === 'string' ? ev.digit : '';
        if (keepsCollecting(map, typed, extensionPrefixes)) {
          armTimer();
        } else {
          settle(resultOf(map, typed, false));
        }
        return;
      }
      if (ev.type === 'ChannelDestroyed' || ev.type === 'StasisEnd') {
        settle({ kind: 'hangup' });
      }
    }
    ari.on('event', onEvent);
    ari.channels.play(channelId, media, playbackId).catch((error: unknown) => {
      if (isChannelGone(error)) {
        settle({ kind: 'hangup' });
        return;
      }
      greetingEnded();
    });
  });
}
