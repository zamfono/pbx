import { z } from 'zod';

import { newId } from '@zamfono/shared';

import { recordChange } from '../audit.js';
import { insertForwardTarget } from '../forwardTargetSpec.js';
import { propagate } from '../propagate.js';
import { defineOperation } from '../types.js';
import {
  assertAudioAvailable,
  assertNameAvailable,
  menuFields,
  toMenuOut,
  type MenuOut
} from './_shared.js';

const DEFAULT_TIMEOUT_S = 5;
const DEFAULT_MAX_ATTEMPTS = 3;

export const menuInputSchema = z.object(menuFields).strict();

export const createMenu = defineOperation({
  name: 'menus.create',
  description:
    'Creates an auto-attendant menu: a greeting, a DTMF-to-target map (menus.setTargets) and a fallback.',
  input: menuInputSchema,
  minRole: 'admin',
  entity: (_input, out: MenuOut) => ({ kind: 'menu', id: out.id }),
  run: async (ctx, input) => {
    await assertNameAvailable(ctx.db, input.name);
    await assertAudioAvailable(ctx.db, input.audioId);
    const id = newId();
    const fallbackTargetId = await insertForwardTarget(
      ctx,
      input.fallbackTarget
    );
    await ctx.db
      .insertInto('menus')
      .values({
        id,
        name: input.name,
        audioId: input.audioId,
        timeoutS: input.timeoutS ?? DEFAULT_TIMEOUT_S,
        maxAttempts: input.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
        allowExtensionDialing: input.allowExtensionDialing ? 1 : 0,
        fallbackTargetId,
        createdAt: ctx.now
      })
      .execute();
    recordChange(ctx, { field: 'name', from: null, to: input.name });
    const row = await ctx.db
      .selectFrom('menus')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirstOrThrow();
    // Read by the routing pipeline (§3.1), and nothing in it reaches Asterisk's own
    // configuration, so this drops `core`'s config cache without a reload.
    propagate(ctx, []);
    return toMenuOut(ctx.db, row);
  }
});
