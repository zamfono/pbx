import pino from 'pino';

import { nowIso, type Db } from '@zamfono/shared';

import { sendMail } from '#lib/server/mail/index.js';
import type { Keyring } from '#lib/server/secretbox.js';

const logger = pino({ name: 'mfa' });

/** What changed: a method added or removed (`passkeyName` naming a passkey, absent for the
 *  authenticator app), or every method reset. */
export type MfaChange =
  { kind: 'added' | 'removed'; passkeyName?: string } | { kind: 'reset' };

/** Mails `userId` that their second factors changed (§5.2 "Two-factor authentication", §10.2
 *  "Mail"), in the tenant language; skipped without a relay or an address. Not awaited by its
 *  callers: the change stands whether or not the mail goes out. */
export function noticeMfaChange(
  db: Db,
  kr: Keyring,
  userId: string,
  change: MfaChange
): void {
  sendMail(db, kr, {
    kind: 'mfaChanged',
    to: { userId },
    values: {
      added: change.kind === 'added',
      removed: change.kind === 'removed',
      reset: change.kind === 'reset',
      passkeyName: change.kind === 'reset' ? '' : (change.passkeyName ?? ''),
      changedAt: nowIso()
    }
  }).catch((error: unknown) => {
    logger.warn({ err: error }, 'mfa: change notice failed');
  });
}
