import { z } from 'zod';

import {
  createTarget,
  resolveTarget,
  targetInputSchema,
  type TargetInput
} from '../dids/_shared.js';
import { orBefore } from '../patch.js';
import { propagate, recordChange } from '../runner.js';
import { defineOperation, OpError, type Context } from '../types.js';
import {
  assertVisibleScope,
  isoDatetimeInput,
  liveOooRulesInScope,
  normalizeIsoOrNull,
  rangesOverlap,
  scopeFromColumns,
  type ScopeInput
} from './_shared.js';

const STATUS_NOT_FOUND = 404;
const STATUS_UNPROCESSABLE_ENTITY = 422;

const inputSchema = z
  .object({
    id: z.string(),
    active: z.boolean().optional(),
    startsAt: isoDatetimeInput.nullable().optional(),
    expiresAt: isoDatetimeInput.nullable().optional(),
    target: targetInputSchema.optional()
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
      STATUS_UNPROCESSABLE_ENTITY,
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
      STATUS_UNPROCESSABLE_ENTITY,
      'ooo: active period overlaps an existing rule in this scope'
    );
  }
}

/** `PATCH /ooo/{id}` (§10.2 "Out of office"): active flag, schedule and target are editable. */
export const update = defineOperation<Input, Output>({
  name: 'ooo.update',
  description: 'Changes an out-of-office rule',
  input: inputSchema,
  minRole: 'user',
  entity: input => ({ kind: 'oooRule', id: input.id }),
  run: async (ctx, input) => {
    const before = await ctx.db
      .selectFrom('oooRules')
      .selectAll()
      .where('id', '=', input.id)
      .where('deletedAt', 'is', null)
      .executeTakeFirst();
    if (!before) {
      throw new OpError(STATUS_NOT_FOUND, 'ooo: rule not found');
    }
    const scope = scopeFromColumns(before);
    assertVisibleScope(ctx.actor, scope, 'ooo: rule not found');
    const active = orBefore(input.active, before.active === 1);
    const { startsAt, expiresAt } = resolveSchedule(input, before);
    if (active) {
      await assertNoOverlap(ctx, scope, input.id, startsAt, expiresAt);
    }
    const beforeTarget = await resolveTarget(ctx.db, before.targetId);
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
