import { z } from 'zod';

import { HTTP_NOT_FOUND } from '@zamfono/shared';

import { arrayPage, pageInput, pageOutput } from '#lib/server/pagination.js';

import { resolveTarget } from '../forwardTargetSpec.js';
import {
  assertScopeExists,
  ownScopeInput,
  scopeInputSchema
} from '../scope.js';
import { defineOperation } from '../types.js';
import { liveOooRulesInScope, oooRuleOut } from './_shared.js';

const inputSchema = z
  .object({
    scope: scopeInputSchema,
    ...pageInput.shape
  })
  .strict();

/**
 * `GET /users/{id}/ooo`, `/ringGroups/{id}/ooo`, `/menus/{id}/ooo`, `/tenant/ooo` (§10.2 "Out of
 * office"): the out-of-office rules of one scope, oldest start first, paginated
 * like every list endpoint (§10.3 "Conventions").
 */
export const list = defineOperation({
  name: 'ooo.list',
  description: "Lists a scope's out-of-office rules",
  input: inputSchema,
  output: pageOutput(oooRuleOut),
  problems: [HTTP_NOT_FOUND],
  minRole: 'user',
  scope: ownScopeInput,
  readOnly: true,
  run: async (ctx, input) => {
    await assertScopeExists(ctx.db, input.scope);
    // A scope's rules are few, so the page is cut from the whole ordered set here rather than
    // in SQL, which keeps `liveOooRulesInScope` the one query the overlap checks share.
    const { page, nextPageToken, totalSize } = arrayPage(
      ctx.operation,
      input,
      await liveOooRulesInScope(ctx.db, input.scope)
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
    return { items, nextPageToken, totalSize };
  }
});
