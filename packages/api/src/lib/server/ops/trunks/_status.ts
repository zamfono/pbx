import type { TrunkStatus } from '@zamfono/shared';

import type { CoreClient } from '#lib/server/coreClient.js';

/** The status `getTrunkStatuses` reports for a trunk that was asked for but never came back
 * reported: unset, or the lookup itself rejected. Also the fallback for a trunk id read back out
 * of the map it builds, since a `Record` index read is typed as possibly absent even for a key
 * that map is known to hold. */
export const UNKNOWN_STATUS: TrunkStatus = {
  status: 'unknown',
  statusChangedAt: null
};

/**
 * Live status the core reports per trunk (`CoreClient.state()`), installed at boot by
 * `hooks.server.ts` through `coreTrunkStatusLookup`. Unset, or while the core is unreachable,
 * every trunk is reported `unknown` (§9.4 "Provisioning and status").
 */
export type TrunkStatusLookup = () => Promise<Record<string, TrunkStatus>>;

/** The lookup that reads the core's internal state (§9.4: "`api` merges `status` and
 * `statusChangedAt` into `GET /trunks` responses at read time from the core's internal API"). */
export function coreTrunkStatusLookup(
  core: Pick<CoreClient, 'state'>
): TrunkStatusLookup {
  return async () => (await core.state()).trunks;
}

// One mutable module slot, held in an object rather than a `let`: ESLint's `init-declarations`
// and `no-undef-init` leave no way to declare an optional `let` binding directly.
const statusLookupHolder: { current: TrunkStatusLookup | undefined } = {
  current: undefined
};

export function setTrunkStatusLookup(
  lookup: TrunkStatusLookup | undefined
): void {
  statusLookupHolder.current = lookup;
}

/** `status`/`statusChangedAt` per id; `unknown` when unreported or the lookup itself rejects (§9.4). */
export async function getTrunkStatuses(
  ids: string[]
): Promise<Record<string, TrunkStatus>> {
  let reported: Record<string, TrunkStatus> = {};
  if (statusLookupHolder.current) {
    try {
      reported = await statusLookupHolder.current();
    } catch {
      reported = {};
    }
  }
  const result: Record<string, TrunkStatus> = {};
  for (const id of ids) {
    result[id] = reported[id] ?? UNKNOWN_STATUS;
  }
  return result;
}
