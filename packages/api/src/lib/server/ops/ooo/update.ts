import { z } from 'zod';

import { HTTP_UNPROCESSABLE_CONTENT } from '@zamfono/shared';

import { recordChange } from '../audit.js';
import { assertMayHoldTarget, createTarget } from '../forwardTargets.js';
import { type TargetSpec } from '../forwardTargetSchema.js';
import { resolveTarget } from '../forwardTargetSpec.js';
import { orBefore } from '../patch.js';
import { propagate } from '../propagate.js';
import {
  assertVisibleScope,
  scopeFromColumns,
  type ScopeInput
} from '../scope.js';
import { defineOperation, OpError, type Context } from '../types.js';
import {
  liveOooRule,
  liveOooRulesInScope,
  normalizeIsoOrNull,
  oooFields,
  rangesOverlap
} from './_shared.js';

const inputSchema = z
  .object({ id: z.string(), ...z.object(oooFields).partial().shape })
  .strict();

type Input = z.infer<typeof inputSchema>;

type Output = {
  id: string;
  scope: ScopeInput;
  active: boolean;
  startsAt: string | null;
  expiresAt: string | null;
  target: TargetSpec;
  createdAt: string;
};

/**
 * The next `startsAt`/`expiresAt`, normalized to UTC and defaulted to `before`'s where `input`
 * omits them; refuses an `expiresAt` at or before `startsAt` (§11.2 `ooo_rules` `CHECK`).
 */
function resolveSchedule(
  input: Pick<Input, 'expiresAt' | 'startsAt'>,
  before: { expiresAt: string | null; startsAt: string | null }
): { expiresAt: string | null; startsAt: string | null } {
  const startsAt = orBefore(
    normalizeIsoOrNull(input.startsAt),
    before.startsAt
  );
  const expiresAt = orBefore(
    normalizeIsoOrNull(input.expiresAt),
    before.expiresAt
  );
  if (startsAt !== null && expiresAt !== null && !(startsAt < expiresAt)) {
    throw new OpError(
      HTTP_UNPROCESSABLE_CONTENT,
      'ooo: expiresAt must be after startsAt'
    );
  }
  return { startsAt, expiresAt };
}

/** Refuses a next active period overlapping another active rule in `scope`, `id` excluded. */
async function assertNoOverlap(
  ctx: Context,
  scope: ScopeInput,
  id: string,
  startsAt: string | null,
  expiresAt: string | null
): Promise<void> {
  const existing = await liveOooRulesInScope(ctx.db, scope);
  const overlapping = existing.some(
    rule =>
      rule.id !== id &&
      rule.active === 1 &&
      rangesOverlap(startsAt, expiresAt, rule.startsAt, rule.expiresAt)
  );
  if (overlapping) {
    throw new OpError(
      HTTP_UNPROCESSABLE_CONTENT,
      'ooo: active period overlaps an existing rule in this scope'
    );
  }
}

/** `PATCH /ooo/{id}` (§10.2 "Out of office"): active flag, schedule and target are editable. */
export const update = defineOperation<Input, Output>({
  name: 'ooo.update',
  description:
    "Changes an out-of-office rule's activity, start, expiry or target",
  input: inputSchema,
  minRole: 'user',
  entity: input => ({ kind: 'oooRule', id: input.id }),
  run: async (ctx, input) => {
    const before = await liveOooRule(ctx.db, input.id);
    const scope = scopeFromColumns(before);
    assertVisibleScope(ctx.actor, scope, 'ooo: rule not found');
    const active = orBefore(input.active, before.active === 1);
    const { startsAt, expiresAt } = resolveSchedule(input, before);
    if (active) {
      await assertNoOverlap(ctx, scope, input.id, startsAt, expiresAt);
    }
    const beforeTarget = await resolveTarget(ctx.db, before.targetId);
    if (input.target === undefined) {
      // A rule kept as it is keeps its target, which a `user` may not do for a `sip` one.
      assertMayHoldTarget(ctx, beforeTarget);
    }
    const targetId =
      input.target === undefined
        ? before.targetId
        : await createTarget(ctx, input.target);
    if (active !== (before.active === 1)) {
      recordChange(ctx, {
        field: 'active',
        from: before.active === 1,
        to: active
      });
    }
    if (startsAt !== before.startsAt) {
      recordChange(ctx, {
        field: 'startsAt',
        from: before.startsAt,
        to: startsAt
      });
    }
    if (expiresAt !== before.expiresAt) {
      recordChange(ctx, {
        field: 'expiresAt',
        from: before.expiresAt,
        to: expiresAt
      });
    }
    if (input.target !== undefined) {
      // The diff names this operation's own input field and carries the wire target, so
      // `audit.undo` replays it straight back through `ooo.update` (§5.8).
      recordChange(ctx, {
        field: 'target',
        from: beforeTarget,
        to: input.target
      });
    }
    await ctx.db
      .updateTable('oooRules')
      .set({ active: active ? 1 : 0, startsAt, expiresAt, targetId })
      .where('id', '=', input.id)
      .execute();
    const target = input.target ?? beforeTarget;
    // Read by the routing pipeline (§3.1), and nothing in it reaches Asterisk's own
    // configuration, so this drops `core`'s config cache without a reload.
    propagate(ctx, []);
    return {
      id: before.id,
      scope,
      active,
      startsAt,
      expiresAt,
      target,
      createdAt: before.createdAt
    };
  }
});
