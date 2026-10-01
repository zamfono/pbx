import { z } from 'zod';

import { newId } from '@zamfono/shared';

import { recordChange } from '../runner.js';
import { defineOperation } from '../types.js';
import {
  phoneSchema,
  replacePhones,
  tenantCountry,
  toContactOut,
  type ContactOut
} from './_shared.js';

export const contactInputSchema = z
  .object({
    displayName: z.string().min(1),
    company: z.string().nullish(),
    email: z.email().nullish(),
    phones: z
      .array(phoneSchema)
      .optional()
      .describe(
        'The contact numbers; on update, the set is replaced as a whole.'
      )
  })
  .strict();

export const createContact = defineOperation({
  name: 'contacts.create',
  description:
    'Adds a contact to the tenant-wide phone book; its numbers name inbound callers.',
  input: contactInputSchema,
  minRole: 'admin',
  entity: (_input, out: ContactOut) => ({ kind: 'contact', id: out.id }),
  run: async (ctx, input) => {
    const id = newId();
    await ctx.db
      .insertInto('contacts')
      .values({
        id,
        displayName: input.displayName,
        company: input.company ?? null,
        email: input.email ?? null,
        createdAt: ctx.now,
        updatedAt: ctx.now
      })
      .execute();
    if (input.phones) {
      const country = await tenantCountry(ctx.db);
      await replacePhones(ctx.db, id, input.phones, country);
      // Recorded in `contactInputSchema`'s `phones` shape, which `contacts.update` accepts, so
      // an undo replays `from` through that operation (§5.8).
      recordChange(ctx, { field: 'phones', from: [], to: input.phones });
    }
    recordChange(ctx, {
      field: 'displayName',
      from: null,
      to: input.displayName
    });
    const row = await ctx.db
      .selectFrom('contacts')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirstOrThrow();
    return toContactOut(ctx.db, row);
  }
});
