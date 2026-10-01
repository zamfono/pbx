import { z } from 'zod';

import { decodeCursor, encodeCursor } from '#lib/pagination.js';

import { resolveTarget } from '../dids/_shared.js';
import { defineOperation } from '../types.js';
import {
  assertOwnScopeOrAdmin,
  liveOooRulesInScope,
  scopeInputSchema
} from './_shared.js';

const DEFAULT_LIMIT = 50;

const inputSchema = z
  .object({
    scope: scopeInputSchema,
    limit: z.number().int().positive().optional(),
    cursor: z.string().optional()
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
    const offset =
      input.cursor === undefined
        ? 0
        : (decodeCursor(input.cursor) as { offset: number }).offset;
    const limit = input.limit ?? DEFAULT_LIMIT;
    // A scope's rules are few, so the page is cut from the whole ordered set here rather than
    // in SQL, which keeps `liveOooRulesInScope` the one query the overlap checks share.
    const rows = await liveOooRulesInScope(ctx.db, input.scope);
    const items = await Promise.all(
      rows.slice(offset, offset + limit).map(async row => ({
        id: row.id,
        scope: input.scope,
        active: row.active === 1,
        startsAt: row.startsAt,
        expiresAt: row.expiresAt,
        target: await resolveTarget(ctx.db, row.targetId),
        createdAt: row.createdAt
      }))
    );
    const nextCursor =
      rows.length > offset + limit
        ? encodeCursor({ offset: offset + limit })
        : null;
    return { items, nextCursor };
  }
});
