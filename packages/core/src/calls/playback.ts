/**
 * Plays media on a channel and waits for it to actually finish (§10.1 step 6, §10.2 "Voicemail"):
 * announce, voicemail's greeting and goodbye, and the menu greeting all act on the caller only
 * once the media has played to the end, never right after the play request is merely accepted.
 */
import type { AriClient } from '../ari/client.js';
import { AriError, type AriEvent, type Channel } from '../ari/types.js';

// Asterisk emits a caller channel's StasisEnd and ChannelDestroyed exactly once each; a caller
// channel already torn down before this wait's own listener was registered (an earlier
// playAndWait/recording wait on the same channel already consumed both) makes the play request
// itself fail, which ends the wait at once. This fallback (10 minutes) is only the safety net for
// a playback whose events never arrive, far longer than any real prompt.
const PLAYBACK_FALLBACK_MS = 600_000;

const HTTP_NOT_FOUND = 404;

/** How a wait ended: the media played out, the channel went away, or no playback happened. */
export type PlaybackEnd = 'finished' | 'hangup' | 'failed';

/** Whether a rejected ARI request says the channel no longer exists: ARI answers 404 "Channel
 * not found" for a channel that has hung up, which no event this listener registers will report. */
export function isChannelGone(error: unknown): boolean {
  return error instanceof AriError && error.status === HTTP_NOT_FOUND;
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
  return new Promise(resolve => {
    const finish = (end: PlaybackEnd): void => {
      // eslint-disable-next-line no-use-before-define -- finish, onEvent and timer all reference each other; each is declared below
      ari.off('event', onEvent);
      // eslint-disable-next-line no-use-before-define -- see above
      clearTimeout(timer);
      resolve(end);
    };
    function onEvent(ev: AriEvent): void {
      const playback = ev.playback as { id?: string } | undefined;
      if (ev.type === 'PlaybackFinished' && playback?.id === playbackId) {
        finish('finished');
        return;
      }
      const channel = ev.channel as Channel | undefined;
      if (
        channel?.id === channelId &&
        (ev.type === 'ChannelDestroyed' || ev.type === 'StasisEnd')
      ) {
        finish('hangup');
      }
    }
    ari.on('event', onEvent);
    const timer = setTimeout(() => {
      finish('failed');
    }, PLAYBACK_FALLBACK_MS);
    timer.unref();
    ari.channels.play(channelId, media, playbackId).catch((error: unknown) => {
      finish(isChannelGone(error) ? 'hangup' : 'failed');
    });
  });
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
  return new Promise(resolve => {
    const finish = (end: PlaybackEnd): void => {
      // eslint-disable-next-line no-use-before-define -- finish, onEvent and timer all reference each other; each is declared below
      ari.off('event', onEvent);
      // eslint-disable-next-line no-use-before-define -- see above
      clearTimeout(timer);
      resolve(end);
    };
    function onEvent(ev: AriEvent): void {
      const channel = ev.channel as Channel | undefined;
      if (
        channel?.id === channelId &&
        (ev.type === 'ChannelDestroyed' || ev.type === 'StasisEnd')
      ) {
        finish('hangup');
      }
    }
    ari.on('event', onEvent);
    const timer = setTimeout(() => {
      ari.playbacks
        .stop(playbackId)
        .catch(() => undefined)
        .finally(() => {
          finish('finished');
        });
    }, durationMs);
    timer.unref();
    ari.channels.play(channelId, media, playbackId).catch((error: unknown) => {
      finish(isChannelGone(error) ? 'hangup' : 'failed');
    });
  });
}
