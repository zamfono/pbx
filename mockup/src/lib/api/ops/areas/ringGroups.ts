/**
 * Ring groups (`ops/ringGroups/`, admin): a group of users and user groups rung together under
 * one extension, assigned on create (the lowest free one), with greeting, music, recording, a
 * group mailbox and two forwarding rules (`unanswered`, `unavailable`). A delete is refused while
 * a target elsewhere points at the group; its own rules travel with it (§5.9).
 */
import { ApiError, conflict, invalid, notFound } from '../../errors';
import { newId } from '../../ids';
import {
  LOG_LEVEL_OVERRIDES,
  RING_GROUP_FORWARD_CONDITIONS,
  type Db,
  type ForwardTarget,
  type LogLevelOverride,
  type Member,
  type RingGroup,
  type RingGroupForwardRule
} from '../../types';
import { defineOp, type Ctx } from '../core';
import {
  checkTarget,
  requireAudioOfKind,
  softDeleteConfirm,
  targetOwners
} from './ooo';

const STRATEGIES = ['simultaneous', 'sequential', 'random'] as const;
const MAX_TIMEOUT_S = 86_400;
const DEFAULT_RING_TIMEOUT_S = 20;
const DEFAULT_MAILBOX_MAX_MESSAGES = 100;
const LOG_LEVEL_DAYS = 7;
const DAY_MS = 86_400_000;
const DECIMAL_BASE = 10;

/** The lowest extension of `extLength` digits that no live user, ring group or parking slot holds
 * and that is no emergency number (`nextExtension`); null when none is left. */
export function nextExtension(db: Db): string | null {
  const used = new Set<string>([
    ...db.users
      .filter(user => user.deletedAt === null && user.extension !== null)
      .map(user => user.extension ?? ''),
    ...db.ringGroups
      .filter(group => group.deletedAt === null)
      .map(group => group.ext),
    ...db.parkingSlots
  ]);
  const length = db.settings.extLength;
  for (let candidate = 1; candidate < DECIMAL_BASE ** length; candidate += 1) {
    const ext = String(candidate).padStart(length, '0');
    if (!used.has(ext) && !db.settings.emergencyNumbers.includes(ext)) {
      return ext;
    }
  }
  return null;
}

function liveGroup(db: Db, id: string): RingGroup {
  const group = db.ringGroups.find(
    row => row.id === id && row.deletedAt === null
  );
  if (group === undefined) {
    throw notFound('ringGroup', id);
  }
  return group;
}

function requireName(db: Db, value: unknown, exceptId?: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw invalid('name', 'groups.required', 'name is required');
  }
  const name = value.trim();
  const clash = db.ringGroups.find(
    row => row.deletedAt === null && row.name === name && row.id !== exceptId
  );
  if (clash !== undefined) {
    throw conflict('duplicate', 'ringGroups: name already in use', [
      { kind: 'ringGroup', id: clash.id, label: clash.name }
    ]);
  }
  return name;
}

function requireTimeout(field: string, value: unknown): number {
  if (
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    value < 1 ||
    value > MAX_TIMEOUT_S
  ) {
    throw invalid(
      field,
      'groups.range',
      `${field} must be an integer 1–${MAX_TIMEOUT_S}`,
      { min: 1, max: MAX_TIMEOUT_S }
    );
  }
  return value;
}

function requireMaxMessages(value: unknown): number | null {
  if (value === null) {
    return null;
  }
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw invalid(
      'mailboxMaxMessages',
      'groups.positive',
      'mailboxMaxMessages must be a positive integer'
    );
  }
  return value;
}

/** `assertMembersValid` and `requireUserExtension`: no member twice, each live, users with an extension. */
function checkMembers(db: Db, members: Member[]): Member[] {
  const seen = new Set<string>();
  for (const member of members) {
    const key = `${member.kind}:${member.id}`;
    if (seen.has(key)) {
      throw invalid(
        'members',
        'groups.duplicateMember',
        `ringGroups: duplicate ${member.kind} member '${member.id}'`
      );
    }
    seen.add(key);
    if (member.kind === 'user') {
      const user = db.users.find(
        row => row.id === member.id && row.deletedAt === null
      );
      if (user === undefined) {
        throw notFound('user', member.id);
      }
      if (user.extension === null) {
        throw conflict(
          'groups.noExtension',
          'ringGroups: the user has no extension; give them one first',
          [{ kind: 'user', id: user.id, label: user.name }]
        );
      }
    } else if (
      db.userGroups.find(
        row => row.id === member.id && row.deletedAt === null
      ) === undefined
    ) {
      throw notFound('userGroup', member.id);
    }
  }
  return members.map(member => ({ kind: member.kind, id: member.id }));
}

type AudioFields = {
  greetingAudioId?: string | null;
  mohAudioId?: string | null;
  mailboxAudioId?: string | null;
};

function checkAudio(db: Db, input: AudioFields): void {
  const refs: [keyof AudioFields, string][] = [
    ['greetingAudioId', 'greeting'],
    ['mohAudioId', 'moh'],
    ['mailboxAudioId', 'vmGreeting']
  ];
  for (const [field, kind] of refs) {
    const id = input[field];
    if (id !== undefined && id !== null) {
      requireAudioOfKind(db, field, id, kind);
    }
  }
}

function requireStrategy(value: unknown): RingGroup['strategy'] {
  if (!STRATEGIES.includes(value as RingGroup['strategy'])) {
    throw invalid(
      'strategy',
      'groups.strategy',
      'strategy must be simultaneous, sequential or random'
    );
  }
  return value as RingGroup['strategy'];
}

export type RingGroupInput = {
  name: string;
  strategy: RingGroup['strategy'];
  ringTimeoutS?: number;
  ringTotalS?: number | null;
  skipBusy?: boolean;
  allowReject?: boolean;
  greetingAudioId?: string | null;
  mohAudioId?: string | null;
  recordCalls?: boolean;
  mailboxEnabled?: boolean;
  mailboxAudioId?: string | null;
  mailboxMaxMessages?: number | null;
  members?: Member[];
};

export type RingGroupUpdate = { id: string } & Partial<RingGroupInput> & {
    logLevel?: LogLevelOverride | null;
    logLevelExpiresAt?: string | null;
  };

defineOp<Record<string, never>, { items: RingGroup[] }>({
  name: 'ringGroups.list',
  minRole: 'admin',
  readOnly: true,
  run: ctx => ({
    items: ctx.db.ringGroups
      .filter(row => row.deletedAt === null)
      .toSorted((first, second) => first.name.localeCompare(second.name))
  })
});

defineOp<{ id: string }, RingGroup>({
  name: 'ringGroups.get',
  minRole: 'admin',
  readOnly: true,
  run: (ctx, input) => liveGroup(ctx.db, input.id)
});

defineOp<RingGroupInput, RingGroup>({
  name: 'ringGroups.create',
  minRole: 'admin',
  run: (ctx, input) => {
    const db = ctx.db;
    const name = requireName(db, input.name);
    const strategy = requireStrategy(input.strategy);
    checkAudio(db, input);
    const ext = nextExtension(db);
    if (ext === null) {
      throw invalid(
        'ext',
        'groups.noFreeExtension',
        'no free extension left at the tenant extension length'
      );
    }
    const row: RingGroup = {
      id: newId(),
      name,
      ext,
      strategy,
      members: checkMembers(db, input.members ?? []),
      ringTimeoutS:
        input.ringTimeoutS === undefined
          ? DEFAULT_RING_TIMEOUT_S
          : requireTimeout('ringTimeoutS', input.ringTimeoutS),
      ringTotalS:
        input.ringTotalS === undefined || input.ringTotalS === null
          ? null
          : requireTimeout('ringTotalS', input.ringTotalS),
      skipBusy: input.skipBusy ?? true,
      allowReject: input.allowReject ?? true,
      greetingAudioId: input.greetingAudioId ?? null,
      mohAudioId: input.mohAudioId ?? null,
      recordCalls: input.recordCalls ?? false,
      mailboxEnabled: input.mailboxEnabled ?? false,
      mailboxAudioId: input.mailboxAudioId ?? null,
      mailboxMaxMessages:
        input.mailboxMaxMessages === undefined
          ? DEFAULT_MAILBOX_MAX_MESSAGES
          : requireMaxMessages(input.mailboxMaxMessages),
      logLevel: null,
      logLevelExpiresAt: null,
      createdAt: ctx.now,
      deletedAt: null
    };
    ctx.insert('ringGroups', row);
    ctx.audit({
      entityKind: 'ringGroup',
      entityId: row.id,
      before: null,
      after: row
    });
    return row;
  }
});

/** `resolveLogLevel` (§7): null clears, a level without expiry ends 7 days later. */
function resolveLogLevel(
  ctx: Ctx,
  before: RingGroup,
  input: RingGroupUpdate
): Pick<RingGroup, 'logLevel' | 'logLevelExpiresAt'> | undefined {
  if (input.logLevel === undefined && input.logLevelExpiresAt === undefined) {
    return undefined;
  }
  if (input.logLevel === null) {
    return { logLevel: null, logLevelExpiresAt: null };
  }
  const level = input.logLevel ?? before.logLevel;
  if (level === null) {
    throw invalid(
      'logLevelExpiresAt',
      'groups.logLevelExpiry',
      'logLevelExpiresAt needs a logLevel to expire'
    );
  }
  if (!LOG_LEVEL_OVERRIDES.includes(level)) {
    throw invalid(
      'logLevel',
      'groups.logLevel',
      'logLevel must be events, qos or sip'
    );
  }
  return {
    logLevel: level,
    logLevelExpiresAt:
      input.logLevelExpiresAt ??
      new Date(Date.parse(ctx.now) + LOG_LEVEL_DAYS * DAY_MS).toISOString()
  };
}

defineOp<RingGroupUpdate, RingGroup>({
  name: 'ringGroups.update',
  minRole: 'admin',
  run: (ctx, input) => {
    const db = ctx.db;
    const before = liveGroup(db, input.id);
    const name =
      input.name === undefined || input.name === before.name
        ? before.name
        : requireName(db, input.name, before.id);
    checkAudio(db, input);
    const next: RingGroup = {
      ...before,
      name,
      strategy:
        input.strategy === undefined
          ? before.strategy
          : requireStrategy(input.strategy),
      ringTimeoutS:
        input.ringTimeoutS === undefined
          ? before.ringTimeoutS
          : requireTimeout('ringTimeoutS', input.ringTimeoutS),
      ringTotalS:
        input.ringTotalS === undefined
          ? before.ringTotalS
          : input.ringTotalS === null
            ? null
            : requireTimeout('ringTotalS', input.ringTotalS),
      skipBusy: input.skipBusy ?? before.skipBusy,
      allowReject: input.allowReject ?? before.allowReject,
      greetingAudioId:
        input.greetingAudioId === undefined
          ? before.greetingAudioId
          : input.greetingAudioId,
      mohAudioId:
        input.mohAudioId === undefined ? before.mohAudioId : input.mohAudioId,
      recordCalls: input.recordCalls ?? before.recordCalls,
      mailboxEnabled: input.mailboxEnabled ?? before.mailboxEnabled,
      mailboxAudioId:
        input.mailboxAudioId === undefined
          ? before.mailboxAudioId
          : input.mailboxAudioId,
      mailboxMaxMessages:
        input.mailboxMaxMessages === undefined
          ? before.mailboxMaxMessages
          : requireMaxMessages(input.mailboxMaxMessages),
      members:
        input.members === undefined
          ? before.members
          : checkMembers(db, input.members),
      ...resolveLogLevel(ctx, before, input)
    };
    const previous = { ...before };
    ctx.put('ringGroups', next);
    ctx.audit({
      entityKind: 'ringGroup',
      entityId: next.id,
      before: previous,
      after: next
    });
    return next;
  }
});

const pointsAt =
  (id: string) =>
  (target: ForwardTarget): boolean =>
    (target.kind === 'ringGroup' || target.kind === 'mailboxRingGroup') &&
    target.ringGroupId === id;

/** Where ring group `id` is still a target, outside its own rules (`findRingGroupReferences`). */
export const ringGroupReferences = (db: Db, id: string) =>
  targetOwners(db, pointsAt(id), { ringGroupId: id });

defineOp<{ id: string }, { id: string }>({
  name: 'ringGroups.delete',
  minRole: 'admin',
  confirm: (ctx, input) => {
    const group = liveGroup(ctx.db, input.id);
    return softDeleteConfirm(ctx, 'ringGroups.delete', {
      name: group.name,
      ext: group.ext
    });
  },
  run: (ctx, input) => {
    const group = liveGroup(ctx.db, input.id);
    const refs = ringGroupReferences(ctx.db, group.id);
    if (refs.length > 0) {
      throw conflict('inUse', 'ring group is still in use', refs);
    }
    const before = { ...group };
    ctx.softDelete('ringGroups', group.id);
    // The extension's BLF keys go with it (`device_blf_keys` rows of the freed extension).
    ctx.db.blf.forEach((entry, index) => {
      if (entry.keys.includes(group.ext)) {
        ctx.setKey('blf', String(index), {
          ...entry,
          keys: entry.keys.filter(key => key !== group.ext)
        });
      }
    });
    ctx.audit({
      entityKind: 'ringGroup',
      entityId: group.id,
      before,
      after: { ...before, deletedAt: ctx.now }
    });
    return { id: group.id };
  }
});

defineOp<{ id: string }, { id: string; rules: RingGroupForwardRule[] }>({
  name: 'ringGroups.getForwarding',
  minRole: 'admin',
  readOnly: true,
  run: (ctx, input) => {
    liveGroup(ctx.db, input.id);
    const order = (rule: RingGroupForwardRule): number =>
      RING_GROUP_FORWARD_CONDITIONS.indexOf(rule.condition);
    return {
      id: input.id,
      rules: (ctx.db.ringGroupForwarding[input.id] ?? []).toSorted(
        (first, second) => order(first) - order(second)
      )
    };
  }
});

defineOp<
  { id: string; rules: RingGroupForwardRule[] },
  { id: string; rules: RingGroupForwardRule[] }
>({
  name: 'ringGroups.setForwarding',
  minRole: 'admin',
  run: (ctx, input) => {
    liveGroup(ctx.db, input.id);
    const seen = new Set<string>();
    for (const rule of input.rules) {
      if (!RING_GROUP_FORWARD_CONDITIONS.includes(rule.condition)) {
        throw invalid(
          'rules',
          'groups.condition',
          `unknown condition '${rule.condition}'`
        );
      }
      if (seen.has(rule.condition)) {
        throw new ApiError(
          422,
          'groups.duplicateCondition',
          `ringGroups: duplicate forwarding condition '${rule.condition}'`,
          {
            field: 'rules',
            params: { condition: rule.condition }
          }
        );
      }
      seen.add(rule.condition);
    }
    const rules = input.rules.map(rule => ({
      condition: rule.condition,
      target: checkTarget(ctx, 'rules', rule.target)
    }));
    const before = { rules: ctx.db.ringGroupForwarding[input.id] ?? [] };
    ctx.setKey('ringGroupForwarding', input.id, rules);
    ctx.audit({
      entityKind: 'ringGroup',
      entityId: input.id,
      before,
      after: { rules }
    });
    return { id: input.id, rules };
  }
});
