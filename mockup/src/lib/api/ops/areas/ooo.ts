/**
 * Out of office (`ops/ooo/`, §10.2): rules per scope — the tenant, a user, a ring group or a menu
 * — that send the scope's calls to a target while in effect, ahead of opening hours. A `user`
 * manages their own user scope only, and never sets a `sip` or recording target. Active periods
 * within one scope must not overlap.
 *
 * Also the helpers the ring-group, menu, audio and hours operations share: scope checks, the
 * forward-target checks of `forwardTargetSpec.ts`/`forwardTargets.ts`, the blocking references of
 * `forwardTargetOwners.ts` and the soft-delete confirmation of `rows.ts`.
 */
import {
  sameScope,
  scheduleStates,
  scopeKey,
  transitions
} from '#lib/components/schedule-scope/status.js';

import { ApiError, invalid, notFound, type BlockingRef } from '../../errors';
import { newId } from '../../ids';
import type { Db, ForwardTarget, OooRule, ScheduleScope } from '../../types';
import { defineOp, type ConfirmInfo, type Ctx } from '../core';
import { E164 } from '../validate';

/* ---------------- shared helpers ---------------- */

const SIP_USER = /^[A-Za-z0-9._~+-]{1,64}$/u;

const live = <T extends { deletedAt: string | null }>(
  row: T | undefined
): T | undefined =>
  row !== undefined && row.deletedAt === null ? row : undefined;

/** The scope's name, or undefined when its user, ring group or menu is not live. */
export function scopeName(db: Db, scope: ScheduleScope): string | undefined {
  switch (scope.kind) {
    case 'tenant':
      return db.settings.companyName;
    case 'user':
      return live(db.users.find(row => row.id === scope.id))?.name;
    case 'ringGroup':
      return live(db.ringGroups.find(row => row.id === scope.id))?.name;
    case 'menu':
      return live(db.menus.find(row => row.id === scope.id))?.name;
  }
}

/** Throws 404 unless `scope` names a live user, ring group or menu (`assertScopeExists`). */
export function requireScope(db: Db, scope: ScheduleScope): string {
  const name = scopeName(db, scope);
  if (name === undefined) {
    throw notFound(scope.kind, scope.kind === 'tenant' ? 'tenant' : scope.id);
  }
  return name;
}

/** The `scope` gate of the schedule operations: a `user`'s own user scope alone (`ownScopeInput`). */
export const isOwnScope = (ctx: Ctx, scope: ScheduleScope): boolean =>
  scope.kind === 'user' && scope.id === ctx.actor.id;

/** Whether only an admin sets or keeps `target`: `sip`, or an `external` one that records. */
export const isAdminTarget = (target: ForwardTarget): boolean =>
  target.kind === 'sip' || (target.kind === 'external' && target.record);

/** 403 for a `user` holding an admin target (`assertMayHoldTarget`). */
export function assertMayHoldTarget(ctx: Ctx, target: ForwardTarget): void {
  if (ctx.actor.role === 'user' && isAdminTarget(target)) {
    throw new ApiError(
      403,
      'groups.adminTarget',
      target.kind === 'sip'
        ? 'a sip target is set by an admin'
        : 'a recording target is set by an admin'
    );
  }
}

/** Throws 404 unless audio `id` is live, 422 unless it is of `kind` (`assertAudioOfKind`). */
export function requireAudioOfKind(
  db: Db,
  field: string,
  id: string,
  kind: string
): void {
  const asset = live(db.audio.find(row => row.id === id));
  if (asset === undefined) {
    throw notFound('audio', id);
  }
  if (asset.kind !== kind) {
    throw invalid(
      field,
      'groups.audioKind',
      `audio asset '${id}' is of kind '${asset.kind}', not '${kind}'`,
      { kind }
    );
  }
}

/** The checks a target passes before it is stored (`createTarget` → `insertForwardTarget`): the
 * caller may hold it, its fields are well-formed, and what it names is live. */
export function checkTarget(
  ctx: Ctx,
  field: string,
  target: ForwardTarget
): ForwardTarget {
  assertMayHoldTarget(ctx, target);
  const db = ctx.db;
  switch (target.kind) {
    case 'user':
    case 'mailboxUser':
      if (live(db.users.find(row => row.id === target.userId)) === undefined) {
        throw notFound('user', target.userId);
      }
      break;
    case 'ringGroup':
    case 'mailboxRingGroup':
      if (
        live(db.ringGroups.find(row => row.id === target.ringGroupId)) ===
        undefined
      ) {
        throw notFound('ringGroup', target.ringGroupId);
      }
      break;
    case 'menu':
      if (live(db.menus.find(row => row.id === target.menuId)) === undefined) {
        throw notFound('menu', target.menuId);
      }
      break;
    case 'announcement':
      requireAudioOfKind(db, field, target.audioId, 'announcement');
      break;
    case 'external':
      if (!E164.test(target.external)) {
        throw invalid(field, 'groups.e164', 'external must be E.164', {
          value: target.external
        });
      }
      break;
    case 'sip':
      if (!SIP_USER.test(target.user)) {
        throw invalid(
          field,
          'groups.sipUser',
          'user must be 1-64 of A-Z a-z 0-9 . _ ~ + -'
        );
      }
      if (
        live(db.trunks.find(row => row.id === target.trunkId)) === undefined
      ) {
        throw notFound('trunk', target.trunkId);
      }
      break;
  }
  return target;
}

/** Whether a schedule row's scope is live; rows of a deleted scope travel with it (§5.9). */
const scopeLive = (db: Db, scope: ScheduleScope): boolean =>
  scopeName(db, scope) !== undefined;

export type OwnScope = { ringGroupId?: string; menuId?: string };

const ownScopeOf = (scope: ScheduleScope, exclude: OwnScope): boolean =>
  (scope.kind === 'ringGroup' && scope.id === exclude.ringGroupId) ||
  (scope.kind === 'menu' && scope.id === exclude.menuId);

/**
 * Every live owner of a forward target matching `matches`, outside `exclude`'s own scope (whose
 * rules travel with it): the §5.9 blocking references of `findForwardTargetOwners`.
 */
export function targetOwners(
  db: Db,
  matches: (target: ForwardTarget) => boolean,
  exclude: OwnScope = {}
): BlockingRef[] {
  const refs: BlockingRef[] = [];
  for (const did of db.dids) {
    if (did.deletedAt === null && matches(did.target)) {
      refs.push({ kind: 'did', id: did.id, label: did.label ?? did.number });
    }
  }
  for (const block of db.didBlocks) {
    if (
      block.deletedAt === null &&
      block.fallbackTarget !== null &&
      matches(block.fallbackTarget)
    ) {
      refs.push({
        kind: 'didBlock',
        id: block.id,
        label: block.label ?? block.base
      });
    }
  }
  if (
    db.settings.fallbackTarget !== null &&
    matches(db.settings.fallbackTarget)
  ) {
    refs.push({
      kind: 'settings',
      id: 'tenant',
      label: db.settings.companyName
    });
  }
  for (const [userId, rules] of Object.entries(db.userForwarding)) {
    const user = live(db.users.find(row => row.id === userId));
    for (const rule of rules) {
      if (user !== undefined && matches(rule.target)) {
        refs.push({
          kind: 'user',
          id: userId,
          label: `${user.name} · ${rule.condition}`
        });
      }
    }
  }
  for (const menu of db.menus) {
    if (menu.deletedAt !== null || menu.id === exclude.menuId) {
      continue;
    }
    if (matches(menu.fallbackTarget)) {
      refs.push({ kind: 'menu', id: menu.id, label: menu.name });
    }
    for (const option of menu.targets) {
      if (matches(option.target)) {
        refs.push({
          kind: 'menu',
          id: menu.id,
          label: `${menu.name} · ${option.digits}`
        });
      }
    }
  }
  for (const [groupId, rules] of Object.entries(db.ringGroupForwarding)) {
    const group = live(db.ringGroups.find(row => row.id === groupId));
    if (group === undefined || groupId === exclude.ringGroupId) {
      continue;
    }
    for (const rule of rules) {
      if (matches(rule.target)) {
        refs.push({
          kind: 'ringGroup',
          id: groupId,
          label: `${group.name} · ${rule.condition}`
        });
      }
    }
  }
  for (const rule of db.oooRules) {
    if (
      rule.deletedAt === null &&
      scopeLive(db, rule.scope) &&
      !ownScopeOf(rule.scope, exclude) &&
      matches(rule.target)
    ) {
      refs.push({
        kind: 'oooRule',
        id: rule.id,
        label: scopeName(db, rule.scope) ?? ''
      });
    }
  }
  for (const hours of db.openingHours) {
    if (
      hours.deletedAt === null &&
      scopeLive(db, hours.scope) &&
      !ownScopeOf(hours.scope, exclude) &&
      matches(hours.closedTarget)
    ) {
      refs.push({
        kind: 'openingHours',
        id: hours.id,
        label: scopeName(db, hours.scope) ?? ''
      });
    }
  }
  return refs;
}

/** The soft-delete question of `rows.ts`: what goes, and how long the delete can be undone. */
export function softDeleteConfirm(
  ctx: Ctx,
  key: string,
  params: Record<string, string | number>
): ConfirmInfo {
  const days = ctx.db.settings.softDeleteRetentionDays;
  return {
    key: days === null ? `${key}Anytime` : key,
    params: { ...params, days: days ?? 0 },
    destructive: true
  };
}

/** Emits the `ooo`/`hours` transitions a schedule write causes, as `core`'s sweep does after a
 * configuration change; `before` from `scheduleStates` at the start of the run. */
export function emitTransitions(
  ctx: Ctx,
  before: ReturnType<typeof scheduleStates>
): void {
  for (const event of transitions(before, scheduleStates(ctx.db))) {
    ctx.emit(event);
  }
}

/** An ISO 8601 instant with offset, normalised to UTC (`isoDatetimeInput`, `toUtcIso`). */
export function isoInput(
  field: string,
  value: string | null | undefined
): string | null | undefined {
  if (value === undefined || value === null) {
    return value;
  }
  const time = Date.parse(value);
  if (!/(Z|[+-]\d{2}:\d{2})$/u.test(value) || Number.isNaN(time)) {
    throw invalid(
      field,
      'groups.datetime',
      `${field} must be ISO 8601 with an offset`
    );
  }
  return new Date(time).toISOString();
}

/* ---------------- out of office ---------------- */

const liveRule = (db: Db, id: string): OooRule => {
  const rule = db.oooRules.find(row => row.id === id && row.deletedAt === null);
  if (rule === undefined) {
    throw notFound('oooRule', id);
  }
  return rule;
};

/** The scope gate of the operations addressing a rule by id; 404 for a rule that is not live. */
const ruleScopeIsOwn = (ctx: Ctx, id: string): boolean =>
  isOwnScope(ctx, liveRule(ctx.db, id).scope);

const startOrder = (rule: OooRule): string => rule.startsAt ?? '';

/** Every live rule of `scope`, starting soonest first (no start = now), ties by id. */
export const rulesInScope = (db: Db, scope: ScheduleScope): OooRule[] =>
  db.oooRules
    .filter(rule => rule.deletedAt === null && sameScope(rule.scope, scope))
    .toSorted(
      (first, second) =>
        startOrder(first).localeCompare(startOrder(second)) ||
        first.id.localeCompare(second.id)
    );

/** Whether the half-open periods intersect, `null` standing for the unbounded side. */
function overlaps(
  aStart: string | null,
  aEnd: string | null,
  bStart: string | null,
  bEnd: string | null
): boolean {
  const aBeforeBEnds = aStart === null || bEnd === null || aStart < bEnd;
  const bBeforeAEnds = bStart === null || aEnd === null || bStart < aEnd;
  return aBeforeBEnds && bBeforeAEnds;
}

function assertSchedule(
  ctx: Ctx,
  scope: ScheduleScope,
  startsAt: string | null,
  expiresAt: string | null,
  active: boolean,
  excludeId?: string
): void {
  if (startsAt !== null && expiresAt !== null && !(startsAt < expiresAt)) {
    throw invalid(
      'expiresAt',
      'groups.oooOrder',
      'ooo: expiresAt must be after startsAt'
    );
  }
  if (!active) {
    return;
  }
  const clash = rulesInScope(ctx.db, scope).find(
    rule =>
      rule.id !== excludeId &&
      rule.active &&
      overlaps(startsAt, expiresAt, rule.startsAt, rule.expiresAt)
  );
  if (clash !== undefined) {
    throw invalid(
      'startsAt',
      'groups.oooOverlap',
      'ooo: active period overlaps an existing rule in this scope'
    );
  }
}

defineOp<{ scope: ScheduleScope }, { items: OooRule[] }>({
  name: 'ooo.list',
  minRole: 'user',
  scope: (ctx, input) => isOwnScope(ctx, input.scope),
  readOnly: true,
  run: (ctx, input) => {
    requireScope(ctx.db, input.scope);
    return { items: rulesInScope(ctx.db, input.scope) };
  }
});

type OooFields = {
  active?: boolean;
  startsAt?: string | null;
  expiresAt?: string | null;
  target: ForwardTarget;
};

defineOp<{ scope: ScheduleScope } & OooFields, OooRule>({
  name: 'ooo.create',
  minRole: 'user',
  scope: (ctx, input) => isOwnScope(ctx, input.scope),
  run: (ctx, input) => {
    requireScope(ctx.db, input.scope);
    const before = scheduleStates(ctx.db);
    const active = input.active ?? true;
    const startsAt = isoInput('startsAt', input.startsAt) ?? null;
    const expiresAt = isoInput('expiresAt', input.expiresAt) ?? null;
    assertSchedule(ctx, input.scope, startsAt, expiresAt, active);
    const target = checkTarget(ctx, 'target', input.target);
    const row: OooRule = {
      id: newId(),
      scope: input.scope,
      active,
      startsAt,
      expiresAt,
      target,
      createdAt: ctx.now,
      deletedAt: null
    };
    ctx.insert('oooRules', row);
    ctx.audit({
      entityKind: 'oooRule',
      entityId: row.id,
      before: null,
      after: row
    });
    emitTransitions(ctx, before);
    return row;
  }
});

defineOp<{ id: string } & Partial<OooFields>, OooRule>({
  name: 'ooo.update',
  minRole: 'user',
  scope: (ctx, input) => ruleScopeIsOwn(ctx, input.id),
  run: (ctx, input) => {
    const rule = liveRule(ctx.db, input.id);
    requireScope(ctx.db, rule.scope);
    const before = scheduleStates(ctx.db);
    const active = input.active ?? rule.active;
    const startsAt =
      input.startsAt === undefined
        ? rule.startsAt
        : (isoInput('startsAt', input.startsAt) ?? null);
    const expiresAt =
      input.expiresAt === undefined
        ? rule.expiresAt
        : (isoInput('expiresAt', input.expiresAt) ?? null);
    assertSchedule(ctx, rule.scope, startsAt, expiresAt, active, rule.id);
    let target = rule.target;
    if (input.target === undefined) {
      // A rule kept as it is keeps its target, which a `user` may not do for an admin target.
      assertMayHoldTarget(ctx, rule.target);
    } else {
      target = checkTarget(ctx, 'target', input.target);
    }
    const previous = { ...rule };
    const next: OooRule = { ...rule, active, startsAt, expiresAt, target };
    ctx.put('oooRules', next);
    ctx.audit({
      entityKind: 'oooRule',
      entityId: rule.id,
      before: previous,
      after: next
    });
    emitTransitions(ctx, before);
    return next;
  }
});

defineOp<{ id: string }, { id: string }>({
  name: 'ooo.delete',
  minRole: 'user',
  scope: (ctx, input) => ruleScopeIsOwn(ctx, input.id),
  confirm: (ctx, input) => {
    const rule = liveRule(ctx.db, input.id);
    return softDeleteConfirm(ctx, 'ooo.delete', {
      name: requireScope(ctx.db, rule.scope),
      scope: scopeKey(rule.scope)
    });
  },
  run: (ctx, input) => {
    const rule = liveRule(ctx.db, input.id);
    requireScope(ctx.db, rule.scope);
    const before = scheduleStates(ctx.db);
    const previous = { ...rule };
    ctx.softDelete('oooRules', rule.id);
    ctx.audit({
      entityKind: 'oooRule',
      entityId: rule.id,
      before: previous,
      after: { ...previous, deletedAt: ctx.now }
    });
    emitTransitions(ctx, before);
    return { id: rule.id };
  }
});
