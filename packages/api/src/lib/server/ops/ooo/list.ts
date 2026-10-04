import { z } from 'zod';

import {
  decodeOffsetCursor,
  offsetPage,
  pageInput
} from '#lib/server/pagination.js';

import { resolveTarget } from '../forwardTargetSpec.js';
import {
  assertOwnScopeOrAdmin,
  assertScopeExists,
  scopeInputSchema
} from '../scope.js';
import { defineOperation } from '../types.js';
import { liveOooRulesInScope } from './_shared.js';

const inputSchema = z
  .object({
    scope: scopeInputSchema,
    ...pageInput.shape
  })
  .strict();

/**
 * `GET /users/{id}/ooo`, `/ringGroups/{id}/ooo`, `/menus/{id}/ooo`, `/tenant/ooo` (§10.2 "Out of
 * office"): the out-of-office rules of one scope, oldest start first, offset-cursor paginated
 * like every list endpoint (§10.3 "Conventions").
 */
export const list = defineOperation({
  name: 'ooo.list',
  description: "Lists a scope's out-of-office rules",
  input: inputSchema,
  minRole: 'user',
  readOnly: true,
  run: async (ctx, input) => {
    assertOwnScopeOrAdmin(ctx.actor, input.scope);
    await assertScopeExists(ctx.db, input.scope);
    const offset = decodeOffsetCursor(ctx.operation, input.cursor);
    const { limit } = input;
    // A scope's rules are few, so the page is cut from the whole ordered set here rather than
    // in SQL, which keeps `liveOooRulesInScope` the one query the overlap checks share.
    const rows = await liveOooRulesInScope(ctx.db, input.scope);
    const { page, nextCursor } = offsetPage(
      ctx.operation,
      rows.slice(offset, offset + limit + 1),
      offset,
      limit
    );
    const items = await Promise.all(
      page.map(async row => ({
        id: row.id,
        scope: input.scope,
        active: row.active === 1,
        startsAt: row.startsAt,
        expiresAt: row.expiresAt,
        target: await resolveTarget(ctx.db, row.targetId),
        createdAt: row.createdAt
      }))
    );
    return { items, nextCursor };
  }
});
