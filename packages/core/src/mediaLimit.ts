/**
 * `MEDIA_STORAGE_MAX` on `core`'s side (§11.6 "Media storage limit"): at or over it, no new call
 * recording starts and no voicemail message is taken. Calls start far more often than uploads, so
 * a measurement of the media volume serves every check for `MEDIA_USAGE_CACHE_MS` before the
 * volume is walked again.
 */
import { mediaUsageBytes } from '@zamfono/shared';

import type { Logger } from './ari/types.js';

/** How long one walk of the media volume answers before the next (§11.6). */
export const MEDIA_USAGE_CACHE_MS = 10_000;

export type MediaLimit = {
  /** Whether the media volume is at or over the limit, as of a walk at most
   * `MEDIA_USAGE_CACHE_MS` old; never without a limit. */
  full: () => Promise<boolean>;
  /** Whether a call recording may start, `fields` naming it: not while `full`, a refusal logged
   * and counted. */
  admitsRecording: (fields: Record<string, unknown>) => Promise<boolean>;
  /** The recordings refused since `core` started (§7 `zamfono_recordings_refused_total`). */
  readonly refusedRecordings: number;
};

export function mediaLimit(
  mediaDir: string,
  limit: number | null,
  log: Logger,
  now: () => number = Date.now
): MediaLimit {
  let measured: { at: number; usage: Promise<number> } | null = null;
  let refused = 0;
  const full = async (): Promise<boolean> => {
    if (limit === null) {
      return false;
    }
    if (measured === null || now() - measured.at >= MEDIA_USAGE_CACHE_MS) {
      // A volume that cannot be walked counts as empty: the limit never stops a call's recording
      // on a failure of its own, and a write that fails there fails as it would without one.
      measured = {
        at: now(),
        usage: mediaUsageBytes(mediaDir).catch(() => 0)
      };
    }
    return (await measured.usage) >= limit;
  };
  return {
    full,
    admitsRecording: async fields => {
      if (!(await full())) {
        return true;
      }
      refused += 1;
      log.warn(
        fields,
        'recording not started: the media volume is at MEDIA_STORAGE_MAX; the call goes on unrecorded'
      );
      return false;
    },
    get refusedRecordings() {
      return refused;
    }
  };
}
