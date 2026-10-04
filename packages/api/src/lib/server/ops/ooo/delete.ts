import { z } from 'zod';

import { propagate } from '../propagate.js';
import { softDelete } from '../rows.js';
import { assertScopeExists, isOwnScope, scopeFromColumns } from '../scope.js';
import { defineOperation } from '../types.js';
import { liveOooRule } from './_shared.js';

const inputSchema = z.object({ id: z.string() }).strict();

/** `DELETE /ooo/{id}` (§10.2 "Out of office", §5.9): soft-deletes an out-of-office rule. */
export const del = defineOperation({
  name: 'ooo.delete',
  description: 'Removes an out-of-office rule',
  input: inputSchema,
  minRole: 'user',
  scope: async (ctx, input) =>
    isOwnScope(ctx, scopeFromColumns(await liveOooRule(ctx.db, input.id))),
  confirm: input => `Delete out-of-office rule ${input.id}?`,
  entity: input => ({ kind: 'oooRule', id: input.id }),
  run: async (ctx, input) => {
    const rule = await liveOooRule(ctx.db, input.id);
    const scope = scopeFromColumns(rule);
    await assertScopeExists(ctx.db, scope);
    await softDelete(ctx, 'oooRules', input.id);
    // Read by the routing pipeline (§3.1), and nothing in it reaches Asterisk's own
    // configuration, so this drops `core`'s config cache without a reload.
    propagate(ctx, []);
    return { id: input.id };
  }
});
