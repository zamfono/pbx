import type { Db } from '@zamfono/shared';

import type { Keyring } from '../secretbox.js';
import { sendMail, type UpdateMailRequest } from './send.js';

/** Sends one mail; `sendMail` in production, a recorder in tests. */
export type SendUpdateMail = (
  req: UpdateMailRequest
) => Promise<'failed' | 'sent' | 'skipped'>;

/** `sendMail` over `db`'s relay with `kr`. */
export function updateMailSender(db: Db, kr: Keyring): SendUpdateMail {
  return async req => sendMail(db, kr, req);
}

/**
 * Sends the mail `build` makes for each live owner, one each, so every owner is greeted by name
 * (§6.3 "Updates", §10.2 "Mail"); a relay that is not configured skips them all.
 */
export async function mailOwners(
  db: Db,
  send: SendUpdateMail,
  build: (userId: string) => UpdateMailRequest
): Promise<void> {
  const owners = await db
    .selectFrom('users')
    .select('id')
    .where('role', '=', 'owner')
    .where('deletedAt', 'is', null)
    .execute();
  await Promise.all(owners.map(async owner => send(build(owner.id))));
}
