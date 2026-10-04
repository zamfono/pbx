import { z } from 'zod';

import { fromFlag, recordChange, recordFieldChanges } from '../audit.js';
import { assertMayHoldTarget, createTarget } from '../forwardTargets.js';
import { resolveTarget } from '../forwardTargetSpec.js';
import { orBefore } from '../patch.js';
import { propagate } from '../propagate.js';
import { assertScopeExists, isOwnScope, scopeFromColumns } from '../scope.js';
import { defineOperation } from '../types.js';
import {
  assertExpiryAfterStart,
  assertNoOverlap,
  liveOooRule,
  normalizeIsoOrNull,
  oooFields,
  type OooRuleOut
} from './_shared.js';

const inputSchema = z
  .object({ id: z.string(), ...z.object(oooFields).partial().shape })
  .strict();

type Input = z.infer<typeof inputSchema>;

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
  assertExpiryAfterStart(startsAt, expiresAt);
  return { startsAt, expiresAt };
}

/** `PATCH /ooo/{id}` (§10.2 "Out of office"): active flag, schedule and target are editable. */
export const update = defineOperation<Input, OooRuleOut>({
  name: 'ooo.update',
  description:
    "Changes an out-of-office rule's activity, start, expiry or target",
  input: inputSchema,
  minRole: 'user',
  scope: async (ctx, input) =>
    isOwnScope(ctx, scopeFromColumns(await liveOooRule(ctx.db, input.id))),
  entity: input => ({ kind: 'oooRule', id: input.id }),
  run: async (ctx, input) => {
    const before = await liveOooRule(ctx.db, input.id);
    const scope = scopeFromColumns(before);
    await assertScopeExists(ctx.db, scope);
    const active = orBefore(input.active, before.active === 1);
    const { startsAt, expiresAt } = resolveSchedule(input, before);
    if (active) {
      await assertNoOverlap(ctx, scope, startsAt, expiresAt, input.id);
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
    const columns = { active: active ? 1 : 0, startsAt, expiresAt };
    recordFieldChanges(ctx, before, columns, { active: { decode: fromFlag } });
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
      .set({ ...columns, targetId })
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
