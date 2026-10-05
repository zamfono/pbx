import type { Transaction } from 'kysely';

import { addMsIso, MS_PER_SECOND, type DB } from '@zamfono/shared';

/**
 * Deletes the `sip_bans` rows that ended longer ago than `settings.sip_ban_lookback_s` (§5.6,
 * §5.9): lifted then, or else expired then. An active ban, a permanent one included, has not
 * ended, so it stays, and so does the history the escalation looks at.
 */
export async function purgeEndedSipBans(
  trx: Transaction<DB>,
  lookbackS: number,
  now: string
): Promise<void> {
  const cutoff = addMsIso(now, -lookbackS * MS_PER_SECOND);
  await trx
    .deleteFrom('sipBans')
    .where(eb =>
      eb.or([
        eb('liftedAt', '<', cutoff),
        eb.and([eb('liftedAt', 'is', null), eb('expiresAt', '<', cutoff)])
      ])
    )
    .execute();
}
