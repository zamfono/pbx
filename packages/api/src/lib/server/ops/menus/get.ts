import { z } from 'zod';

import { defineOperation } from '../types.js';
import { liveMenu, toMenuOut } from './_shared.js';

export const getMenu = defineOperation({
  name: 'menus.get',
  description: 'Reads one live menu by id.',
  input: z.object({ id: z.string() }).strict(),
  minRole: 'admin',
  readOnly: true,
  run: async (ctx, input) => {
    const row = await liveMenu(ctx.db, input.id);
    return toMenuOut(ctx.db, row);
  }
});
