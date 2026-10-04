import { z } from 'zod';

import { HTTP_NOT_FOUND } from '@zamfono/shared';

import { defineOperation } from '../types.js';
import { liveMenu, menuTargetRows, menuTargetsSchema } from './_shared.js';

/**
 * `GET /menus/{id}/targets` (§10.3): reads a menu's DTMF map as `{ id, targets }`, the shape
 * `menus.setTargets` takes and returns, so a read, an edit and a `PUT` round-trip unchanged.
 */
export const getMenuTargets = defineOperation({
  name: 'menus.getTargets',
  description: "Reads a menu's DTMF-to-target map.",
  input: z.object({ id: z.string() }).strict(),
  output: menuTargetsSchema,
  problems: [HTTP_NOT_FOUND],
  minRole: 'admin',
  readOnly: true,
  run: async (ctx, input) => {
    await liveMenu(ctx.db, input.id);
    return { id: input.id, targets: await menuTargetRows(ctx.db, input.id) };
  }
});
