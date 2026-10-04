import { z } from 'zod';

import { HTTP_NOT_FOUND } from '@zamfono/shared';

import { defineOperation } from '../types.js';
import { contactOut, liveContact, toContactOut } from './_shared.js';

export const getContact = defineOperation({
  name: 'contacts.get',
  description: 'Reads one live contact by id.',
  input: z.object({ id: z.string() }).strict(),
  output: contactOut,
  problems: [HTTP_NOT_FOUND],
  minRole: 'user',
  scope: 'any',
  readOnly: true,
  run: async (ctx, input) => {
    const row = await liveContact(ctx.db, input.id);
    return toContactOut(ctx.db, row);
  }
});
