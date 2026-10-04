import pino from 'pino';

import type { Db } from '@zamfono/shared';

import { errorMessage } from '../errors.js';
import { activeRingotelProvider } from '../provisioning/index.js';
import type { UserRow } from '../provisioning/types.js';
import { afterPropagation } from './afterCommit.js';
import { loadSettings } from './settings/_shared.js';
import type { Context } from './types.js';

const log = pino({ name: 'ringotel' });

/**
 * `settings.ringotel_roster_pending` (§10.4 "Colleague presence", §11.4): set while a roster
 * change has been stored but has not reached Ringotel.
 */
export async function setRosterPending(
  db: Db,
  pending: boolean
): Promise<void> {
  await db
    .updateTable('settings')
    .set({ ringotelRosterPending: pending ? 1 : 0 })
    .where('id', '=', 1)
    .execute();
}

/**
 * Runs `onRosterChanged` for `users`, never throwing: `null` once Ringotel took it, which clears
 * the marker, else Ringotel's reason, which keeps it set.
 */
async function attempt(db: Db, users: UserRow[]): Promise<string | null> {
  try {
    const provider = await activeRingotelProvider(db);
    await provider?.onRosterChanged?.(users);
    await setRosterPending(db, false);
    return null;
  } catch (error) {
    await setRosterPending(db, true);
    return errorMessage(error);
  }
}

/**
 * §10.4 `onRosterChanged`, "on every user or extension change": the provider's tenant-wide roster
 * (Ringotel's branch `blfs` list, one entry per extension titled by its owner, and the parking
 * slots) moves whenever a user, ring group or slot gains, loses or renames an extension, so each
 * operation that does so calls this once its own writes have landed. `users` are the rows whose
 * own extension, SIP username, name or e-mail moved and must reach their Ringotel user too.
 *
 * The push runs once the write committed and Asterisk holds it, so a Ringotel outage never fails
 * the write and a renamed app registers against an endpoint that exists. The marker is set inside
 * the write's own transaction, so an `api` that stops before the push still owes it; a refusal is
 * a `warnings` entry of the operation's result.
 */
export async function pushRoster(
  ctx: Context,
  users: UserRow[] = []
): Promise<void> {
  const settings = await loadSettings(ctx.db);
  if (settings.ringotelOrgId === null || settings.ringotelBranchId === null) {
    return;
  }
  await setRosterPending(ctx.db, true);
  afterPropagation(ctx, async db => {
    const reason = await attempt(db, users);
    if (reason === null) {
      return null;
    }
    log.error({ reason }, 'ringotel: the roster push was refused');
    return `the change is stored and in force on the PBX, but Ringotel refused the roster (${reason}); api pushes the whole roster again at its next start, when Asterisk next starts, or with the next roster change`;
  });
}

/**
 * One more try for a roster push Ringotel refused before, at `api`'s start or at an Asterisk start
 * (§10.4 "Colleague presence"): the whole roster, every live user included, since which users a
 * refused push carried is not kept. Nothing is sent while none is pending; a refusal keeps the
 * marker for the next such moment, never for a timer, so nothing loops.
 */
export async function retryPendingRoster(db: Db): Promise<void> {
  const settings = await loadSettings(db);
  if (settings.ringotelRosterPending !== 1) {
    return;
  }
  const users = await db
    .selectFrom('users')
    .selectAll()
    .where('deletedAt', 'is', null)
    .execute();
  const reason = await attempt(db, users);
  if (reason === null) {
    log.info('ringotel: the pending roster was pushed');
  } else {
    log.error({ reason }, 'ringotel: the pending roster was refused again');
  }
}
