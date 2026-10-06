#!/usr/bin/env node
// Resets the two-factor sign-in of an owner who lost every method and recovery code and has no
// other owner to reset it through `users.resetMfa` (spec §5.2 "Two-factor authentication"). The
// api image ships it at /app/reset-mfa.mjs, and it runs against the live database:
//
//   docker compose exec api node reset-mfa.mjs owner@example.com
//
// It removes the owner's methods and recovery codes, ends their sessions and records the reset in
// the audit log as the system's (channel `job`). The owner signs in with their password next and
// sets up a second factor again.
import { dbFileFrom, newId, nowIso, openDb, resetMfa } from '@zamfono/shared';

const REFUSED_EXIT_CODE = 1;

/**
 * Resets the live owner `email`'s second factors in `db`; `false` when no live owner has it.
 * @param {import('@zamfono/shared').Db} db
 * @param {string} email
 * @returns {Promise<boolean>}
 */
async function resetOwner(db, email) {
  const owner = await db
    .selectFrom('users')
    .select(['id', 'name'])
    .where('email', '=', email)
    .where('role', '=', 'owner')
    .where('deletedAt', 'is', null)
    .executeTakeFirst();
  if (owner === undefined) {
    console.error(`reset-mfa: no live owner has the e-mail '${email}'`);
    return false;
  }
  const now = nowIso();
  await db.transaction().execute(async trx => {
    const before = await resetMfa(trx, owner.id, now);
    await trx
      .insertInto('auditLog')
      .values({
        id: newId(),
        actorUserId: 'system',
        actorUserName: 'Zamfono',
        channel: 'job',
        clientId: null,
        clientName: null,
        operation: 'users.resetMfa',
        entityKind: 'user',
        entityId: owner.id,
        changesJson: JSON.stringify([
          { field: 'mfa', from: before, to: null },
          { field: 'tokensRevoked', from: false, to: true }
        ]),
        undoable: 0,
        revertsId: null,
        undoneAt: null,
        createdAt: now
      })
      .execute();
  });
  console.log(
    `reset-mfa: two-factor sign-in of ${owner.name} reset; they set it up at their next sign-in`
  );
  return true;
}

const [, , email = ''] = process.argv;
if (email === '') {
  console.error('reset-mfa: usage: node reset-mfa.mjs <owner e-mail>');
  process.exitCode = REFUSED_EXIT_CODE;
} else {
  const db = openDb(dbFileFrom(process.env.DB_FILE));
  try {
    if (!(await resetOwner(db, email))) {
      process.exitCode = REFUSED_EXIT_CODE;
    }
  } finally {
    await db.destroy();
  }
}
