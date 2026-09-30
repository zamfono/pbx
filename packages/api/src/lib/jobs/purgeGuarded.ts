/**
 * The purges of §5.9 that a live reference holds back (`purge.ts`'s `runPurge`): a due row that
 * another row still depends on stays soft-deleted and is reconsidered by the next daily pass,
 * rather than failing the whole pass on a `RESTRICT` or leaving a DID outside every block.
 */
import { sql, type Transaction } from 'kysely';

import type { DB } from '@zamfono/shared';

/**
 * §5.9: a due `did_blocks` row is hard-deleted once no live DID's number lies within it — the
 * number begins with the block's base and, for a digits block, has the block's digit count.
 * Membership is derived from the number, so the condition is the one `did_blocks_purge_guard`
 * enforces; a block still holding a live DID stays soft-deleted and is reconsidered daily until
 * the admin retargets or removes those DIDs.
 */
export async function purgeDidBlocks(
  trx: Transaction<DB>,
  cutoff: string
): Promise<void> {
  await trx
    .deleteFrom('didBlocks')
    .where('deletedAt', 'is not', null)
    .where('deletedAt', '<', cutoff)
    .where(
      sql<boolean>`not exists (
        select 1 from dids
        where dids.deleted_at is null
          and dids.number glob did_blocks.base || '*'
          and (did_blocks.digits is null
            or length(dids.number) = length(did_blocks.base) + did_blocks.digits))`
    )
    .execute();
}

/**
 * §5.9: a due trunk is hard-deleted once no `forward_targets` row dials over it. A soft-deleted
 * user's or menu's own `sip` target still names the trunk until that owner is purged in its turn,
 * later than the trunk where the owner was deleted after it; purging the trunk earlier would fail
 * the whole pass on the `RESTRICT` at commit, so the trunk stays soft-deleted and is reconsidered
 * daily, like a block that still holds a DID.
 */
export async function purgeTrunks(
  trx: Transaction<DB>,
  cutoff: string
): Promise<void> {
  await trx
    .deleteFrom('trunks')
    .where('deletedAt', 'is not', null)
    .where('deletedAt', '<', cutoff)
    .where(
      sql<boolean>`not exists (
        select 1 from forward_targets where forward_targets.sip_trunk_id = trunks.id)`
    )
    .execute();
}
