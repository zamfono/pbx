import { z } from 'zod';

import { recordChange } from '../runner.js';
import { defineOperation, OpError } from '../types.js';

const STATUS_NOT_FOUND = 404;

/**
 * `DELETE /contacts/{id}` (§10.3 "Phone book"): soft-deletes a contact. Nothing in the routing
 * vocabulary references a contact, so no blocking-reference check applies (§5.9).
 */
export const deleteContact = defineOperation({
  name: 'contacts.delete',
  description: 'Soft-deletes a phone-book contact.',
  input: z.object({ id: z.string() }).strict(),
  minRole: 'admin',
  confirm: input =>
    `Delete this contact? The deletion can be undone for 30 days. (${input.id})`,
  entity: input => ({ kind: 'contact', id: input.id }),
  run: async (ctx, input) => {
    const before = await ctx.db
      .selectFrom('contacts')
      .select('id')
      .where('id', '=', input.id)
      .where('deletedAt', 'is', null)
      .executeTakeFirst();
    if (!before) {
      throw new OpError(STATUS_NOT_FOUND, `contact '${input.id}' not found`);
    }
    await ctx.db
      .updateTable('contacts')
      .set({ deletedAt: ctx.now })
      .where('id', '=', input.id)
      .execute();
    recordChange(ctx, { field: 'deletedAt', from: null, to: ctx.now });
    return { id: input.id };
  }
});
