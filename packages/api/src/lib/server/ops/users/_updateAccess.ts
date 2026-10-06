/**
 * Who may write what through `users.update` (§5.3, §10.3): a `user` only their own self-service
 * fields, only an owner a role, and only an owner an owner's e-mail.
 */
import { HTTP_FORBIDDEN } from '@zamfono/shared';

import { OpError, type Context } from '../types.js';
import { assertNotLastOwner, type UserRow } from './_shared.js';

/** §10.3 "Users": the self-service subset a `user` actor may `PATCH` on their own profile. */
const SELF_SERVICE_FIELDS = new Set([
  'clir',
  'rejectAnonymous',
  'ringTimeoutS',
  'notifyMissedCalls',
  'findMe'
]);

/** Throws 403 unless `ctx.actor` may write every field `input` carries (§5.3, §10.3). */
export function assertAllowedFields(ctx: Context, input: object): void {
  if (ctx.actor.role !== 'user') {
    return;
  }
  for (const key of Object.keys(input)) {
    if (key !== 'id' && !SELF_SERVICE_FIELDS.has(key)) {
      throw new OpError(HTTP_FORBIDDEN, `users: '${key}' is admin-only`);
    }
  }
}

/** Throws unless `ctx.actor` may set `input.role` on `before` (§5.3 "only owners change roles"). */
export async function assertRoleChangeAllowed(
  ctx: Context,
  before: UserRow,
  input: { role?: UserRow['role'] }
): Promise<void> {
  if (input.role === undefined || input.role === before.role) {
    return;
  }
  if (ctx.actor.role !== 'owner') {
    throw new OpError(HTTP_FORBIDDEN, 'users: only owners change roles');
  }
  await assertNotLastOwner(ctx.db, before);
}

/** Throws 403 unless `ctx.actor` may change `before`'s e-mail, where a forgot-password link goes:
 *  an owner's is owner-only (§10.3). */
export function assertEmailChangeAllowed(
  ctx: Context,
  before: UserRow,
  input: { email?: string | null }
): void {
  if (
    input.email !== undefined &&
    input.email !== before.email &&
    before.role === 'owner' &&
    ctx.actor.role !== 'owner'
  ) {
    throw new OpError(
      HTTP_FORBIDDEN,
      "users: only owners change an owner's e-mail"
    );
  }
}
