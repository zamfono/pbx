/**
 * The Target-menu step's DTMF collection (§10.1 step 6) for `menu.ts`: the greeting with barge-in,
 * the first-digit and inter-digit timers, and `menuStep` deciding when a typed string
 * resolves.
 */
import { MS_PER_SECOND } from '@zamfono/shared';

import type { AriClient } from '../ari/client.js';
import {
  INTER_DIGIT_TIMEOUT_MS,
  menuStep,
  type MenuMap
} from '../routing/menu.js';
import type { EventWait } from './ariWaits.js';
import { playForKeys, type KeyHangup } from './playback.js';

type CollectResult =
  | { kind: 'match'; targetId: string; typed: string }
  | { kind: 'unmatched'; typed: string }
  | KeyHangup;

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
 * play request is refused (`playback.ts`'s `playForKeys`). The caller hanging up ends the
 * collection as `hangup`, never as silence. A string `map` has given up on (no mapped entry
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
  let typed = '';
  // The first-digit timer counts from the greeting's end, each later one from the last key.
  const armTimer = (wait: EventWait<CollectResult>): void => {
    const ms =
      typed === ''
        ? firstDigitTimeoutS * MS_PER_SECOND
        : INTER_DIGIT_TIMEOUT_MS;
    wait.arm(ms, () => {
      wait.settle(resultOf(map, typed, true));
    });
  };
  return playForKeys<CollectResult>(ari, greeting, {
    mediaEnded: armTimer,
    digit: (digit, wait) => {
      typed += digit;
      if (keepsCollecting(map, typed, extensionPrefixes)) {
        armTimer(wait);
      } else {
        wait.settle(resultOf(map, typed, false));
      }
    }
  });
}
