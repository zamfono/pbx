import { z } from 'zod';

import { HTTP_NOT_FOUND } from '@zamfono/shared';

import { propagate } from '../propagate.js';
import { idOutput, softDelete, softDeleteQuestion } from '../rows.js';
import {
  assertScopeExists,
  ownScopeInput,
  scopeInputSchema,
  scopeLabel
} from '../scope.js';
import { defineOperation, OpError } from '../types.js';
import { loadSchedule } from './_shared.js';

const inputSchema = z.object({ scope: scopeInputSchema }).strict();

/**
 * `DELETE /users/{id}/hours`, `/ringGroups/{id}/hours`, `/menus/{id}/hours`, `/tenant/hours`
 * (§10.2 "Opening hours", §5.9): soft-deletes the scope's schedule, so it follows the tenant's.
 */
export const del = defineOperation({
  name: 'hours.delete',
  description: "Removes a scope's opening-hours schedule",
  input: inputSchema,
  output: idOutput,
  problems: [HTTP_NOT_FOUND],
  minRole: 'user',
  scope: ownScopeInput,
  confirm: async (ctx, input) =>
    softDeleteQuestion(
      ctx,
      `the opening hours of ${await scopeLabel(ctx.db, input.scope)}`
    ),
  entity: (_input, output: { id: string }) => ({
    kind: 'openingHours',
    id: output.id
  }),
  run: async (ctx, input) => {
    await assertScopeExists(ctx.db, input.scope);
    const schedule = await loadSchedule(ctx.db, input.scope);
    if (!schedule) {
      throw new OpError(
        HTTP_NOT_FOUND,
        'hours: no schedule set for this scope'
      );
    }
    await softDelete(ctx, 'openingHours', schedule.id);
    // Read by the routing pipeline (§3.1), and nothing in it reaches Asterisk's own
    // configuration, so this drops `core`'s config cache without a reload.
    propagate(ctx, []);
    return { id: schedule.id };
  }
});
