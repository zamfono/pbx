/**
 * Plays media on a channel and waits for it to actually finish (§10.1 step 6, §10.2 "Voicemail"):
 * announce, voicemail's greeting and goodbye, and the menu greeting all act on the caller only
 * once the media has played to the end, never right after the play request is merely accepted.
 */
import type { AriClient } from '../ari/client.js';
import { isGone, logUnlessGone } from '../ari/failures.js';
import type { Channel } from '../ari/types.js';
import {
  channelLeft,
  playbackFinished,
  waitForEvent,
  type EventWait
} from './ariWaits.js';

// Asterisk emits a caller channel's StasisEnd and ChannelDestroyed exactly once each; a caller
// channel already torn down before this wait's own listener was registered (an earlier
// playAndWait/recording wait on the same channel already consumed both) makes the play request
// itself fail, which ends the wait at once. This fallback (10 minutes) is only the safety net for
// a playback whose events never arrive, far longer than any real prompt.
const PLAYBACK_FALLBACK_MS = 600_000;

/** How a wait ended: the media played out, the channel went away, or no playback happened. */
export type PlaybackEnd = 'finished' | 'hangup' | 'failed';

/** Stops `playbackId` once a key interrupts it, without waiting: the playback having already
 * ended is the expected race, and any other failure is logged. */
export function stopPlayback(ari: AriClient, playbackId: string): void {
  ari.playbacks
    .stop(playbackId)
    .catch(logUnlessGone(ari.log, 'playback stop', { playbackId }));
}

/**
 * Plays `media` on `channelId` and waits for it to end: its own `PlaybackFinished` (matched by the
 * caller-supplied `playbackId`, so the wait does not depend on ARI's response body), the channel
 * ending first, when the caller hangs up mid-playback, the play request being refused, since no
 * playback then follows, or `PLAYBACK_FALLBACK_MS`, so the listener is always eventually removed.
 */
export function playAndWait(
  ari: AriClient,
  channelId: string,
  media: string,
  playbackId: string
): Promise<PlaybackEnd> {
  const wait = waitForEvent<PlaybackEnd>(ari, (ev, waiting) => {
    if (playbackFinished(ev, playbackId)) {
      waiting.settle('finished');
    } else if (channelLeft(ev, channelId)) {
      waiting.settle('hangup');
    }
  });
  wait.arm(PLAYBACK_FALLBACK_MS, () => {
    wait.settle('failed');
  });
  ari.channels.play(channelId, media, playbackId).catch((error: unknown) => {
    wait.settle(isGone(error) ? 'hangup' : 'failed');
  });
  return wait.promise;
}

/**
 * Plays `media` on `channelId` for exactly `durationMs`, then stops it itself, rather than waiting
 * for its own `PlaybackFinished` (§9.4 "Cross-trunk failover"'s special information tone,
 * `indications.ts`: none of its `indications.conf` elements starts with `!`, so it repeats
 * forever once started and never ends on its own). Still resolves early on the channel hanging up
 * mid-tone; the stop request that follows is expected to fail for a channel already gone, so it is
 * not treated as this wait's own failure.
 */
export function playToneAndWait(
  ari: AriClient,
  channelId: string,
  media: string,
  playbackId: string,
  durationMs: number
): Promise<PlaybackEnd> {
  const wait = waitForEvent<PlaybackEnd>(ari, (ev, waiting) => {
    if (channelLeft(ev, channelId)) {
      waiting.settle('hangup');
    }
  });
  wait.arm(durationMs, () => {
    ari.playbacks
      .stop(playbackId)
      .catch(logUnlessGone(ari.log, 'tone stop'))
      .finally(() => {
        wait.settle('finished');
      });
  });
  ari.channels.play(channelId, media, playbackId).catch((error: unknown) => {
    wait.settle(isGone(error) ? 'hangup' : 'failed');
  });
  return wait.promise;
}

/** How a play-then-key wait ends when the channel goes away. */
export type KeyHangup = { kind: 'hangup' };

/** What a play-then-key wait does with the media's end and the caller's keys. */
export type KeyInput<T> = {
  /** Runs once when the media ended without a key: played out, or its play request refused. */
  mediaEnded: (wait: EventWait<T | KeyHangup>) => void;
  /** Runs on every key; the first one has already stopped the media. */
  digit: (digit: string, wait: EventWait<T | KeyHangup>) => void;
};

/**
 * Plays `media` on `channelId` with barge-in and hands the caller's keys to `input`: a key while
 * the media still plays stops it, so a caller who knows the menu never waits for it; otherwise
 * `input.mediaEnded` runs once the media has played out, or at once when Asterisk refuses the
 * play request, since no `PlaybackFinished` then follows. The channel going away (or being gone
 * already, so the play is refused) resolves `hangup`. `playbackId` must be unique per call, since
 * it is what the media's own `PlaybackFinished` is matched by.
 */
export function playForKeys<T>(
  ari: AriClient,
  prompt: {
    channelId: string;
    media: string | readonly string[];
    playbackId: string;
  },
  input: KeyInput<T>
): Promise<T | KeyHangup> {
  const { channelId, media, playbackId } = prompt;
  let playing = true;
  const mediaEnded = (wait: EventWait<T | KeyHangup>): void => {
    if (playing) {
      playing = false;
      input.mediaEnded(wait);
    }
  };
  const wait = waitForEvent<T | KeyHangup>(ari, (ev, waiting) => {
    if (playbackFinished(ev, playbackId)) {
      mediaEnded(waiting);
    } else if (channelLeft(ev, channelId)) {
      waiting.settle({ kind: 'hangup' });
    } else if (
      ev.type === 'ChannelDtmfReceived' &&
      (ev.channel as Channel | undefined)?.id === channelId &&
      typeof ev.digit === 'string'
    ) {
      if (playing) {
        playing = false;
        stopPlayback(ari, playbackId);
      }
      input.digit(ev.digit, waiting);
    }
  });
  ari.channels.play(channelId, media, playbackId).catch((error: unknown) => {
    if (isGone(error)) {
      wait.settle({ kind: 'hangup' });
    } else {
      mediaEnded(wait);
    }
  });
  return wait.promise;
}
