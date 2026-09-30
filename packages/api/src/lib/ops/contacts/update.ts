import type { Transaction } from 'kysely';
import { z } from 'zod';

import type { DB } from '@zamfono/shared';

import { recordChange, recordFieldChanges } from '../runner.js';
import { defineOperation, OpError, type Context } from '../types.js';
import {
  contactPhones,
  phoneSchema,
  replacePhones,
  tenantCountry,
  toContactOut,
  type ContactRow
} from './_shared.js';

const STATUS_NOT_FOUND = 404;

export const updateContactInput = z
  .object({
    id: z.string(),
    displayName: z.string().min(1).optional(),
    company: z.string().nullish(),
    email: z.email().nullish(),
    phones: z.array(phoneSchema).optional()
  })
  .strict();

async function fetchLive(db: Transaction<DB>, id: string): Promise<ContactRow> {
  const row = await db
    .selectFrom('contacts')
    .selectAll()
    .where('id', '=', id)
    .where('deletedAt', 'is', null)
    .executeTakeFirst();
  if (!row) {
    throw new OpError(STATUS_NOT_FOUND, `contact '${id}' not found`);
  }
  return row;
}

/** The row's next scalar values: `input`'s value where given, `before`'s own otherwise. */
function resolvedFields(
  before: ContactRow,
  input: z.infer<typeof updateContactInput>
): Pick<ContactRow, 'displayName' | 'company' | 'email'> {
  return {
    displayName: input.displayName ?? before.displayName,
    company: input.company === undefined ? before.company : input.company,
    email: input.email === undefined ? before.email : input.email
  };
}

export const updateContact = defineOperation({
  name: 'contacts.update',
  description:
    "Updates a contact's details; `phones` replaces the number set as a whole.",
  input: updateContactInput,
  minRole: 'admin',
  entity: input => ({ kind: 'contact', id: input.id }),
  run: async (ctx, input) => {
    const before = await fetchLive(ctx.db, input.id);
    const after = resolvedFields(before, input);
    recordFieldChanges(ctx, before, after);
    await ctx.db
      .updateTable('contacts')
      .set({ ...after, updatedAt: ctx.now })
      .where('id', '=', input.id)
      .execute();
    if (input.phones) {
      const beforePhones = await contactPhones(ctx.db, input.id);
      const country = await tenantCountry(ctx.db);
      await replacePhones(ctx.db, input.id, input.phones, country);
      // Recorded in `updateContactInput`'s `phones` shape, which `contacts.update` accepts, so
      // an undo replays `from` through this operation (§5.8).
      recordChange(ctx, {
        field: 'phones',
        from: beforePhones,
        to: input.phones
      });
    }
    const row = await ctx.db
      .selectFrom('contacts')
      .selectAll()
      .where('id', '=', input.id)
      .executeTakeFirstOrThrow();
    return toContactOut(ctx.db, row);
  }
});
