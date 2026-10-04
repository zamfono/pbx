import { z } from 'zod';

import { changesColumn } from '@zamfono/shared';

import { maskContent } from '../audit.js';
import { idOutput } from '../rows.js';
import { Conflict, defineOperation } from '../types.js';
import { cascadeSoftDeleteUser } from './_cascade.js';
import { findUserReferences } from './_references.js';
import { assertNotLastOwner } from './_shared.js';

const ERASED_ACTOR_NAME = 'erased user';

/**
 * Fields whose `changes_json` value is personal data for the user they belong to (§5.10): the
 * name and e-mail that identify the person, and the numbers they are reached at outside the PBX,
 * which `findMe` (§11.2 `users.find_me_json`) and the forward-rule targets `users.setForwarding`
 * records as `rules` (§11.2 `user_forward_rules`) both carry.
 */
const PERSONAL_FIELDS = new Set(['name', 'email', 'findMe', 'rules']);

/**
 * Redacts the personal field values an entry's `changes_json` carries for `userId`, without
 * touching the diff of any other entity the same entry might mention.
 */
function scrubChanges(changesJson: string): string {
  return changesColumn.encode(
    changesColumn
      .decode(changesJson)
      .map(change =>
        PERSONAL_FIELDS.has(change.field)
          ? { field: change.field, from: '***', to: '***' }
          : change
      )
  );
}

/**
 * `POST /users/{id}/erase` (§5.10): a full-erasure request. Accepts an id whose user row is
 * already hard-purged, since `audit_log` keeps no FK to it.
 */
export const erase = defineOperation({
  name: 'users.erase',
  description:
    "Erases a user's personal data from their audit trail (GDPR, irreversible).",
  input: z.object({ id: z.string() }).strict(),
  output: idOutput,
  minRole: 'owner',
  confirm: async (ctx, input) => {
    const user = await ctx.db
      .selectFrom('users')
      .select('name')
      .where('id', '=', input.id)
      .executeTakeFirst();
    // A user already purged still has audit entries to erase, under their id alone.
    const who = user?.name ?? `user '${input.id}'`;
    return `Erase ${who} and the personal data the audit log holds about them? This cannot be undone.`;
  },
  entity: input => ({ kind: 'user', id: input.id }),
  run: async (ctx, input) => {
    // Before the cascade records the erased user's devices and extension (§5.10).
    maskContent(ctx);
    const user = await ctx.db
      .selectFrom('users')
      .select(['id', 'role', 'deletedAt'])
      .where('id', '=', input.id)
      .executeTakeFirst();
    if (user?.deletedAt === null) {
      await assertNotLastOwner(ctx.db, user);
      // Erasure still soft-deletes rather than orphaning a route: the admin retargets the
      // blocking reference first, same as `users.delete` (§5.9), then erases again.
      const references = await findUserReferences(ctx.db, input.id);
      if (references.length > 0) {
        throw new Conflict('user is still in use', references);
      }
      await cascadeSoftDeleteUser(ctx, input.id);
    }
    await ctx.db
      .updateTable('auditLog')
      .set({ actorUserName: ERASED_ACTOR_NAME })
      .where('actorUserId', '=', input.id)
      .execute();
    const entries = await ctx.db
      .selectFrom('auditLog')
      .select(['id', 'changesJson'])
      .where('entityKind', '=', 'user')
      .where('entityId', '=', input.id)
      .execute();
    await Promise.all(
      entries.map(entry =>
        ctx.db
          .updateTable('auditLog')
          .set({ changesJson: scrubChanges(entry.changesJson), undoable: 0 })
          .where('id', '=', entry.id)
          .execute()
      )
    );
    return { id: input.id };
  }
});
