import { z } from 'zod';

import { newId } from '@zamfono/shared';

import {
  createTarget,
  targetInputSchema,
  type TargetInput
} from '../dids/_shared.js';
import { propagate, recordChange } from '../runner.js';
import { defineOperation, OpError, type Context } from '../types.js';
import {
  assertOwnScopeOrAdmin,
  isoDatetimeInput,
  liveOooRulesInScope,
  normalizeIsoOrNull,
  OOO_FIELD_DESCRIPTIONS,
  rangesOverlap,
  scopeColumns,
  scopeInputSchema,
  type ScopeInput
} from './_shared.js';

const STATUS_UNPROCESSABLE_ENTITY = 422;

const inputSchema = z
  .object({
    scope: scopeInputSchema,
    active: z.boolean().optional().describe(OOO_FIELD_DESCRIPTIONS.active),
    startsAt: isoDatetimeInput
      .nullable()
      .optional()
      .describe(OOO_FIELD_DESCRIPTIONS.startsAt),
    expiresAt: isoDatetimeInput
      .nullable()
      .optional()
      .describe(OOO_FIELD_DESCRIPTIONS.expiresAt),
    target: targetInputSchema.describe(OOO_FIELD_DESCRIPTIONS.target)
  })
  .strict();

type Input = z.infer<typeof inputSchema>;

type Output = {
  id: string;
  scope: ScopeInput;
  active: boolean;
  startsAt: string | null;
  expiresAt: string | null;
  target: TargetInput;
  createdAt: string;
};

/** `expires_at` after `starts_at`, mirroring the table's own `CHECK` (§11.2 `ooo_rules`). */
function assertExpiryAfterStart(
  startsAt: string | null,
  expiresAt: string | null
): void {
  if (startsAt !== null && expiresAt !== null && !(startsAt < expiresAt)) {
    throw new OpError(
      STATUS_UNPROCESSABLE_ENTITY,
      'ooo: expiresAt must be after startsAt'
    );
  }
}

/** Refuses a period overlapping another active rule already live in `scope` (§10.2 "Out of office"). */
async function assertNoOverlap(
  ctx: Context,
  scope: ScopeInput,
  startsAt: string | null,
  expiresAt: string | null
): Promise<void> {
  const existing = await liveOooRulesInScope(ctx.db, scope);
  const overlapping = existing.some(
    rule =>
      rule.active === 1 &&
      rangesOverlap(startsAt, expiresAt, rule.startsAt, rule.expiresAt)
  );
  if (overlapping) {
    throw new OpError(
      STATUS_UNPROCESSABLE_ENTITY,
      'ooo: active period overlaps an existing rule in this scope'
    );
  }
}

/**
 * `POST /users/{id}/ooo`, `/ringGroups/{id}/ooo`, `/menus/{id}/ooo`, `/tenant/ooo` (§10.2 "Out of
 * office"): a scheduled absence and the forward target it applies while in effect.
 */
export const create = defineOperation<Input, Output>({
  name: 'ooo.create',
  description:
    "Adds an out-of-office rule to a scope: while in effect, its calls go to the rule's target, ahead of opening hours",
  input: inputSchema,
  minRole: 'user',
  entity: (_input, output: Output) => ({ kind: 'oooRule', id: output.id }),
  run: async (ctx, input) => {
    assertOwnScopeOrAdmin(ctx.actor, input.scope);
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
