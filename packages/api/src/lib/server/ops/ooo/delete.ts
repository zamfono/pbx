import { z } from 'zod';

import { HTTP_NOT_FOUND } from '@zamfono/shared';

import { propagate, recordChange } from '../runner.js';
import { defineOperation, OpError } from '../types.js';
import {
  assertVisibleScope,
  loadLiveOooRule,
  scopeFromColumns
} from './_shared.js';

const inputSchema = z.object({ id: z.string() }).strict();

/** `DELETE /ooo/{id}` (§10.2 "Out of office", §5.9): soft-deletes an out-of-office rule. */
export const del = defineOperation({
  name: 'ooo.delete',
  description: 'Removes an out-of-office rule',
  input: inputSchema,
  minRole: 'user',
  confirm: input => `Delete out-of-office rule ${input.id}?`,
  entity: input => ({ kind: 'oooRule', id: input.id }),
  run: async (ctx, input) => {
    const rule = await loadLiveOooRule(ctx.db, input.id);
    if (!rule) {
      throw new OpError(HTTP_NOT_FOUND, 'ooo: rule not found');
    }
    assertVisibleScope(
      ctx.actor,
      scopeFromColumns(rule),
      'ooo: rule not found'
    );
    await ctx.db
      .updateTable('oooRules')
      .set({ deletedAt: ctx.now })
      .where('id', '=', input.id)
      .execute();
    recordChange(ctx, { field: 'deletedAt', from: null, to: ctx.now });
    // Read by the routing pipeline (§3.1), and nothing in it reaches Asterisk's own
    // configuration, so this drops `core`'s config cache without a reload.
    propagate(ctx, []);
    return { id: input.id };
  }
});
