import { z } from 'zod';

import { recordChange } from '../runner.js';
import { defineOperation } from '../types.js';
import { liveContact } from './_shared.js';

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
    await liveContact(ctx.db, input.id);
    await ctx.db
      .updateTable('contacts')
      .set({ deletedAt: ctx.now })
      .where('id', '=', input.id)
      .execute();
    recordChange(ctx, { field: 'deletedAt', from: null, to: ctx.now });
    return { id: input.id };
  }
});
