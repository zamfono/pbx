import pino from 'pino';

import type { TrunkStatus } from '@zamfono/shared';

import { getCoreClient } from '#lib/server/coreClient.js';

const logger = pino({ name: 'trunks' });

/** The status `getTrunkStatuses` reports for a trunk that was asked for but never came back
 * reported, or while `core` is unreachable. Also the fallback for a trunk id read back out of
 * the map it builds, since a `Record` index read is typed as possibly absent even for a key that
 * map is known to hold. */
export const UNKNOWN_STATUS: TrunkStatus = {
  status: 'unknown',
  statusChangedAt: null,
  registeredAt: null
};

/**
 * `status`/`statusChangedAt` per id, as `core` reports them in its internal state (§9.4: "`api`
 * merges `status` and `statusChangedAt` into `GET /trunks` responses at read time from the core's
 * internal API"); `unknown` for a trunk it does not report, and for every trunk, logged, while
 * `core` is unreachable.
 */
export async function getTrunkStatuses(
  ids: string[]
): Promise<Record<string, TrunkStatus>> {
  let reported: Record<string, TrunkStatus> = {};
  try {
    reported = (await getCoreClient().state()).trunks;
  } catch (error) {
    logger.warn({ err: error }, 'trunk status unknown: core did not answer');
  }
  const result: Record<string, TrunkStatus> = {};
  for (const id of ids) {
    result[id] = reported[id] ?? UNKNOWN_STATUS;
  }
  return result;
}
