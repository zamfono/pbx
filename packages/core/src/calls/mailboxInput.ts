/**
 * The mailbox menu's one input primitive (§10.2 "Mailbox access"): play a prompt, a list of
 * prompts or a message and take the caller's next key. A key pressed while the media still plays
 * stops it and is the answer at once, so a caller who knows the menu never waits for it; otherwise
 * the wait for a key starts once the media has played out.
 */
import type { AriClient } from '../ari/client.js';
import { playForKeys, type KeyHangup } from './playback.js';

export type MenuInput =
  { kind: 'digit'; digit: string } | { kind: 'timeout' } | KeyHangup;

/**
 * Plays `media` on `channelId` and resolves with the first DTMF key, `timeout` when `waitMs` pass
 * after the media ended without one (`0` returns as soon as it ends), or `hangup` when the channel
 * goes away (`playback.ts`'s `playForKeys`).
 */
export function playForDigit(
  ari: AriClient,
  channelId: string,
  media: string | readonly string[],
  playbackId: string,
  waitMs: number
): Promise<MenuInput> {
  return playForKeys<MenuInput>(
    ari,
    { channelId, media, playbackId },
    {
      mediaEnded: wait => {
        if (waitMs === 0) {
          wait.settle({ kind: 'timeout' });
          return;
        }
        wait.arm(waitMs, () => {
          wait.settle({ kind: 'timeout' });
        });
      },
      digit: (digit, wait) => {
        wait.settle({ kind: 'digit', digit });
      }
    }
  );
}
