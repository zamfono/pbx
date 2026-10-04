import { z } from 'zod';

import { HTTP_NOT_FOUND } from '@zamfono/shared';

import { idOutput, softDelete, softDeleteQuestion } from '../rows.js';
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
  output: idOutput,
  problems: [HTTP_NOT_FOUND],
  minRole: 'admin',
  confirm: async (ctx, input) =>
    softDeleteQuestion(
      ctx,
      `the contact ${(await liveContact(ctx.db, input.id)).displayName}`
    ),
  entity: input => ({ kind: 'contact', id: input.id }),
  run: async (ctx, input) => {
    await liveContact(ctx.db, input.id);
    await softDelete(ctx, 'contacts', input.id);
    return { id: input.id };
  }
});
