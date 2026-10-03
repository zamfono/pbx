import { z } from 'zod';

import { softDelete } from '../rows.js';
import { propagate } from '../runner.js';
import { defineOperation } from '../types.js';
import {
  assertVisibleScope,
  liveOooRule,
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
    const rule = await liveOooRule(ctx.db, input.id);
    assertVisibleScope(
      ctx.actor,
      scopeFromColumns(rule),
      'ooo: rule not found'
    );
    await softDelete(ctx, 'oooRules', input.id);
    // Read by the routing pipeline (§3.1), and nothing in it reaches Asterisk's own
    // configuration, so this drops `core`'s config cache without a reload.
    propagate(ctx, []);
    return { id: input.id };
  }
});
