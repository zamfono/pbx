/**
 * The daily purge's §5.2 credential windows: expired `tokens` rows, the `oauth_clients` rows no
 * token references any more, and revoked or expired personal access tokens. `purge.ts` runs them
 * inside its one transaction.
 */
import type { Transaction } from 'kysely';

import { addMsIso, cutoffIso, type DB } from '@zamfono/shared';

import { CODE_TTL_MS } from '../auth/codes.js';

// §5.2 "Client rows": a client row is hard-deleted 30 days after its last token expired. An
// expired refresh row is kept that long, so "no `tokens` row references it" is the whole test.
const OAUTH_CLIENT_RETENTION_DAYS = 30;

/**
 * §11.2 "tokens": expired rows are purged by the daily job. A reset token goes once it has
 * expired; an expired refresh token stays `OAUTH_CLIENT_RETENTION_DAYS` longer, as the record of
 * its client's last token expiry (§5.2 "Client rows"). `rotateRefresh` refuses it as expired
 * either way, before it looks at `revoked_at`.
 */
export async function purgeExpiredTokens(
  trx: Transaction<DB>,
  now: string
): Promise<void> {
  await trx
    .deleteFrom('tokens')
    .where('kind', '=', 'reset')
    .where('expiresAt', '<', now)
    .execute();
  await trx
    .deleteFrom('tokens')
    .where('kind', '=', 'refresh')
    .where('expiresAt', '<', cutoffIso(now, OAUTH_CLIENT_RETENTION_DAYS))
    .execute();
}

/**
 * §5.2 "Client rows": a client row is hard-deleted once no `tokens` row references it and its
 * last token expired more than 30 days ago. `purgeExpiredTokens`, run first, keeps a refresh row
 * until 30 days past its expiry, so a client no row references any more is exactly one whose
 * last token expired that long ago. A client authorized within the last authorization-code
 * lifetime is spared: its code may not have been redeemed for its first token yet.
 */
export async function purgeOauthClients(
  trx: Transaction<DB>,
  now: string
): Promise<void> {
  const inFlightCutoff = addMsIso(now, -CODE_TTL_MS);
  await trx
    .deleteFrom('oauthClients')
    .where('lastLoginAt', '<', inFlightCutoff)
    .where(eb =>
      eb.not(
        eb.exists(
          eb
            .selectFrom('tokens')
            .select('tokens.tokenHash')
            .whereRef('tokens.clientId', '=', 'oauthClients.clientId')
        )
      )
    )
    .execute();
}

/**
 * §11.2 "personal_access_tokens": a revoked or expired token is purged by the daily job. Nothing
 * reads such a row again, since a replay of a personal access token is just an unknown token.
 */
export async function purgePersonalAccessTokens(
  trx: Transaction<DB>,
  now: string
): Promise<void> {
  await trx
    .deleteFrom('personalAccessTokens')
    .where(eb =>
      eb.or([eb('revokedAt', 'is not', null), eb('expiresAt', '<', now)])
    )
    .execute();
}
