import { z } from 'zod';

import { newId } from '@zamfono/shared';

import { recordChange } from '../audit.js';
import { createTarget } from '../forwardTargets.js';
import { propagate } from '../propagate.js';
import {
  assertOwnScopeOrAdmin,
  assertScopeExists,
  scopeColumns,
  scopeInputSchema
} from '../scope.js';
import { defineOperation } from '../types.js';
import {
  assertExpiryAfterStart,
  assertNoOverlap,
  normalizeIsoOrNull,
  oooFields,
  type OooRuleOut
} from './_shared.js';

const inputSchema = z
  .object({ scope: scopeInputSchema, ...oooFields })
  .strict();

type Input = z.infer<typeof inputSchema>;

/**
 * `POST /users/{id}/ooo`, `/ringGroups/{id}/ooo`, `/menus/{id}/ooo`, `/tenant/ooo` (§10.2 "Out of
 * office"): a scheduled absence and the forward target it applies while in effect.
 */
export const create = defineOperation<Input, OooRuleOut>({
  name: 'ooo.create',
  description:
    "Adds an out-of-office rule to a scope: while in effect, its calls go to the rule's target, ahead of opening hours",
  input: inputSchema,
  minRole: 'user',
  entity: (_input, output: OooRuleOut) => ({ kind: 'oooRule', id: output.id }),
  run: async (ctx, input) => {
    assertOwnScopeOrAdmin(ctx.actor, input.scope);
    await assertScopeExists(ctx.db, input.scope);
    const active = input.active ?? true;
    const startsAt = normalizeIsoOrNull(input.startsAt) ?? null;
    const expiresAt = normalizeIsoOrNull(input.expiresAt) ?? null;
    assertExpiryAfterStart(startsAt, expiresAt);
    if (active) {
      await assertNoOverlap(ctx, input.scope, startsAt, expiresAt);
    }
    const targetId = await createTarget(ctx, input.target);
    const id = newId();
    await ctx.db
      .insertInto('oooRules')
      .values({
        id,
        ...scopeColumns(input.scope),
        active: active ? 1 : 0,
        startsAt,
        expiresAt,
        targetId,
        createdAt: ctx.now
      })
      .execute();
    recordChange(ctx, { field: 'targetId', from: null, to: targetId });
    // Read by the routing pipeline (§3.1), and nothing in it reaches Asterisk's own
    // configuration, so this drops `core`'s config cache without a reload.
    propagate(ctx, []);
    return {
      id,
      scope: input.scope,
      active,
      startsAt,
      expiresAt,
      target: input.target,
      createdAt: ctx.now
    };
  }
});
