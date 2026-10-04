import { z } from 'zod';

import { HTTP_NOT_FOUND } from '@zamfono/shared';

import { propagate } from '../propagate.js';
import { idOutput, softDelete, softDeleteQuestion } from '../rows.js';
import {
  assertScopeExists,
  isOwnScope,
  scopeFromColumns,
  scopeLabel
} from '../scope.js';
import { defineOperation } from '../types.js';
import { liveOooRule } from './_shared.js';

const inputSchema = z.object({ id: z.string() }).strict();

/** `DELETE /ooo/{id}` (§10.2 "Out of office", §5.9): soft-deletes an out-of-office rule. */
export const del = defineOperation({
  name: 'ooo.delete',
  description: 'Removes an out-of-office rule',
  input: inputSchema,
  output: idOutput,
  problems: [HTTP_NOT_FOUND],
  minRole: 'user',
  scope: async (ctx, input) =>
    isOwnScope(ctx, scopeFromColumns(await liveOooRule(ctx.db, input.id))),
  confirm: async (ctx, input) => {
    const rule = await liveOooRule(ctx.db, input.id);
    const owner = await scopeLabel(ctx.db, scopeFromColumns(rule));
    const period = rule.startsAt === null ? '' : ` from ${rule.startsAt}`;
    return softDeleteQuestion(
      ctx,
      `the out-of-office rule of ${owner}${period}`
    );
  },
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
