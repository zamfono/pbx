import { z } from 'zod';

import { defineOperation } from '../types.js';
import { liveContact, toContactOut } from './_shared.js';

export const getContact = defineOperation({
  name: 'contacts.get',
  description: 'Reads one live contact by id.',
  input: z.object({ id: z.string() }).strict(),
  minRole: 'user',
  scope: 'any',
  readOnly: true,
  run: async (ctx, input) => {
    const row = await liveContact(ctx.db, input.id);
    return toContactOut(ctx.db, row);
  }
});
