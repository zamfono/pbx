import type { Context } from '../types.js';
import type { Collision } from './_shared.js';

/** The live row holding `email`, if another user already has it (`users_email`, §11.2). */
async function emailConflict(
  ctx: Context,
  id: string,
  email: string
): Promise<Collision | null> {
  const conflict = await ctx.db
    .selectFrom('users')
    .select(['id', 'name'])
    .where('email', '=', email)
    .where('deletedAt', 'is', null)
    .where('id', '!=', id)
    .executeTakeFirst();
  return conflict
    ? { kind: 'user', id: conflict.id, label: conflict.name }
    : null;
}

/**
 * The live row holding `ssoSubject`, if another user already has it (`users_sso_subject`, §11.2).
 * The index is unique over live rows only, and SQLite lets any number of rows hold NULL, so a
 * user without an SSO identity collides with nobody.
 */
async function ssoSubjectConflict(
  ctx: Context,
  id: string,
  ssoSubject: string | null
): Promise<Collision | null> {
  if (ssoSubject === null) {
    return null;
  }
  const conflict = await ctx.db
    .selectFrom('users')
    .select(['id', 'name'])
    .where('ssoSubject', '=', ssoSubject)
    .where('deletedAt', 'is', null)
    .where('id', '!=', id)
    .executeTakeFirst();
  return conflict
    ? { kind: 'user', id: conflict.id, label: conflict.name }
    : null;
}

/**
 * The live row a revived user would collide with, over either of the two values `users` keeps
 * unique among live rows: the e-mail and the SSO subject (§5.8, §5.9). The extension is checked by
 * `revertExtension`, since it lives in `extensions` rather than on the `users` row.
 */
export async function userReuseConflict(
  ctx: Context,
  id: string
): Promise<Collision | null> {
  const row = await ctx.db
    .selectFrom('users')
    .select(['email', 'ssoSubject'])
    .where('id', '=', id)
    .executeTakeFirst();
  if (!row) {
    return null;
  }
  return (
    (await emailConflict(ctx, id, row.email)) ??
    (await ssoSubjectConflict(ctx, id, row.ssoSubject))
  );
}
