/**
 * The mailbox menu's one input primitive (§10.2 "Mailbox access"): play a prompt, a list of
 * prompts or a message and take the caller's next key. A key pressed while the media still plays
 * stops it and is the answer at once, so a caller who knows the menu never waits for it; otherwise
 * the wait for a key starts once the media has played out.
 */
import type { AriClient } from '../ari/client.js';
import type { AriEvent, Channel } from '../ari/types.js';
import { isChannelGone } from './playback.js';

export type MenuInput =
  { kind: 'digit'; digit: string } | { kind: 'timeout' } | { kind: 'hangup' };

/**
 * Plays `media` on `channelId` and resolves with the first DTMF key, `timeout` when `waitMs` pass
 * after the media ended without one (`0` returns as soon as it ends), or `hangup` when the channel
 * goes away. A play request Asterisk refuses counts as media that ended at once. `playbackId` must
 * be unique per call, since it is what the media's own `PlaybackFinished` is matched by.
 */
export function playForDigit(
  ari: AriClient,
  channelId: string,
  media: string | readonly string[],
  playbackId: string,
  waitMs: number
): Promise<MenuInput> {
  return new Promise(resolve => {
    let playing = true;
    // eslint-disable-next-line init-declarations -- assigned once the media ends, before it can fire
    let timer: ReturnType<typeof setTimeout> | undefined;
    const settle = (input: MenuInput): void => {
      // eslint-disable-next-line no-use-before-define -- settle and onEvent reference each other; onEvent is declared below
      ari.off('event', onEvent);
      clearTimeout(timer);
      resolve(input);
    };
    const mediaEnded = (): void => {
      if (!playing) {
        return;
      }
      playing = false;
      if (waitMs === 0) {
        settle({ kind: 'timeout' });
        return;
      }
      timer = setTimeout(() => {
        settle({ kind: 'timeout' });
      }, waitMs);
      timer.unref();
    };
    function onEvent(ev: AriEvent): void {
      if (ev.type === 'PlaybackFinished') {
        const playback = ev.playback as { id?: string } | undefined;
        if (playback?.id === playbackId) {
          mediaEnded();
        }
        return;
      }
      const channel = ev.channel as Channel | undefined;
      if (channel?.id !== channelId) {
        return;
      }
      if (ev.type === 'ChannelDtmfReceived' && typeof ev.digit === 'string') {
        if (playing) {
          ari.playbacks.stop(playbackId).catch(() => undefined);
        }
        settle({ kind: 'digit', digit: ev.digit });
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
      mediaEnded();
    });
  });
}
