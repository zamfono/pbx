/**
 * Calls (`ops/calls/`, §10.3 "Call history", "Live calls"): the history of ended calls with their
 * routing trace (`calls.list`, `calls.get`) and the calls in progress with their call control.
 *
 * Live actions stand in for `core`: they are not audited, they change `liveCalls` and `parked`,
 * emit `call.state` to the users the call concerns, and a call that ends joins the history with its
 * routing trace (`history.appended`). Rings and answers progress on short timers, as phones would.
 * A `user` sees live calls they are in or rung for, and acts only on a call they placed or have a
 * leg up in (`connectedUserIds`).
 */
import { now as demoNow, nowDate as demoNowDate } from '#lib/clock.svelte.js';
import { onDemoReset } from '#lib/state/demo.js';

import { ApiError, invalid, notFound } from '../../errors';
import { emit } from '../../events.svelte';
import { newId } from '../../ids';
import { store, touch } from '../../store.svelte';
import type {
  Call,
  CallDirection,
  CallLogLine,
  CallStatus,
  Db,
  LiveCall,
  LiveLeg,
  PresenceStatus,
  RingGroup,
  User
} from '../../types';
import { defineOp, type Ctx } from '../core';
import { E164, normaliseNumber } from '../validate';

/* ------------------------------------------------------------------ */
/* Paging and instants, shared by the call-related areas               */
/* ------------------------------------------------------------------ */

export type PageInput = { limit?: number; cursor?: string };
export type Page<T> = { items: T[]; nextCursor: string | null };

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

/** An offset page of `rows` for list operation `operation` (`?limit=` ≤ 200, opaque `?cursor=`). */
export function paginate<T>(
  operation: string,
  rows: T[],
  input: PageInput
): Page<T> {
  const limit = input.limit ?? DEFAULT_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    throw invalid('limit', 'pageLimit', `limit must be 1–${MAX_LIMIT}`, {
      max: MAX_LIMIT
    });
  }
  let offset = 0;
  if (input.cursor !== undefined) {
    try {
      const decoded = JSON.parse(atob(input.cursor)) as {
        list?: string;
        offset?: number;
      };
      if (decoded.list !== operation || typeof decoded.offset !== 'number') {
        throw new Error('foreign cursor');
      }
      offset = decoded.offset;
    } catch {
      throw invalid('cursor', 'pageCursor', 'cursor is not one of this list');
    }
  }
  const end = offset + limit;
  return {
    items: rows.slice(offset, end),
    nextCursor:
      rows.length > end
        ? btoa(JSON.stringify({ list: operation, offset: end }))
        : null
  };
}

const FALLBACK_ZONE = 'Europe/Berlin';

export const tenantZone = (db: Db): string =>
  db.settings.timezone ?? FALLBACK_ZONE;

export type ZonedParts = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  /** 1 (Monday) … 7. */
  weekday: number;
};

const WEEKDAYS: Record<string, number> = {
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
  Sun: 7
};

/** The wall-clock parts of instant `ms` in `timeZone`. */
export function zonedParts(ms: number, timeZone: string): ZonedParts {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    weekday: 'short',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric'
  }).formatToParts(new Date(ms));
  const get = (type: string): string =>
    parts.find(part => part.type === type)?.value ?? '0';
  return {
    year: Number(get('year')),
    month: Number(get('month')),
    day: Number(get('day')),
    hour: Number(get('hour')),
    minute: Number(get('minute')),
    second: Number(get('second')),
    weekday: WEEKDAYS[get('weekday')] ?? 1
  };
}

function zoneOffsetMs(ms: number, timeZone: string): number {
  const p = zonedParts(ms, timeZone);
  const wholeSeconds = ms - (((ms % 1000) + 1000) % 1000);
  return (
    Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) -
    wholeSeconds
  );
}

/** The instant of wall-clock time `year-month-day hour:minute:second` in `timeZone`; overflowing
 * fields roll over as `Date.UTC` rolls them. */
export function zonedToUtc(
  timeZone: string,
  year: number,
  month: number,
  day: number,
  hour = 0,
  minute = 0,
  second = 0
): number {
  const guess = Date.UTC(year, month - 1, day, hour, minute, second);
  const first = zoneOffsetMs(guess, timeZone);
  const candidate = guess - first;
  const second_ = zoneOffsetMs(candidate, timeZone);
  return second_ === first ? candidate : guess - second_;
}

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/u;
const LOCAL_TIME =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?$/u;

/**
 * An instant input (`instantInput.ts`): ISO 8601 with any offset, without one in the tenant's
 * time zone, or a date — its midnight, or with `end` the end of that date. Null when unreadable.
 */
export function parseInstant(
  value: string,
  timeZone: string,
  end = false
): number | null {
  const date = DATE_ONLY.exec(value);
  if (date !== null) {
    const [, year = '0', month = '0', day = '0'] = date;
    return zonedToUtc(
      timeZone,
      Number(year),
      Number(month),
      Number(day) + (end ? 1 : 0)
    );
  }
  const local = LOCAL_TIME.exec(value);
  if (local !== null) {
    const [
      ,
      year = '0',
      month = '0',
      day = '0',
      hour = '0',
      minute = '0',
      second = '0'
    ] = local;
    return zonedToUtc(
      timeZone,
      Number(year),
      Number(month),
      Number(day),
      Number(hour),
      Number(minute),
      Number(second)
    );
  }
  if (!/[zZ]|[+-]\d{2}:?\d{2}$/u.test(value)) {
    return null;
  }
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

export function requireInstant(
  db: Db,
  field: string,
  value: string,
  end = false
): number {
  const ms = parseInstant(value, tenantZone(db), end);
  if (ms === null) {
    throw invalid(
      field,
      'instantInvalid',
      `${field} is not an ISO 8601 time or date`,
      { value }
    );
  }
  return ms;
}

/* ------------------------------------------------------------------ */
/* History                                                             */
/* ------------------------------------------------------------------ */

/** A history row as `calls.list` lists it; `calls.get` adds the diagnostics. */
export type CallOut = Omit<Call, 'log' | 'sipTrace' | 'qos'>;
export type CallDetail = Call & { childCallIds: string[] };

export function toCallOut(call: Call): CallOut {
  const { log: _log, sipTrace: _sip, qos: _qos, ...rest } = call;
  return rest;
}

/** Whether `userId` is the caller, the callee or the answering user of `call` (§5.3). */
export const isOwnCall = (call: Call, userId: string): boolean =>
  call.callerUserId === userId ||
  call.calleeUserId === userId ||
  call.answeredByUserId === userId;

type ListInput = PageInput & {
  direction?: CallDirection;
  from?: string;
  to?: string;
  userId?: string;
  ringGroupId?: string;
  parentCallId?: string;
  status?: CallStatus;
  live?: boolean;
};

/* ------------------------------------------------------------------ */
/* Live calls: the state `core` holds                                 */
/* ------------------------------------------------------------------ */

/** The users who may act on `call` (`connectedUserIds`): the caller and every user with a leg up. */
export function connectedUserIds(call: LiveCall): string[] {
  const ids = call.legs
    .filter(
      leg =>
        leg.userId !== undefined &&
        (leg.role === 'caller' || leg.state !== 'ringing')
    )
    .map(leg => leg.userId as string);
  return [...new Set(ids)];
}

export function isOwnLive(db: Db, callId: string, userId: string): boolean {
  const call = db.liveCalls.find(candidate => candidate.callId === callId);
  return call !== undefined && connectedUserIds(call).includes(userId);
}

type AddedParty = {
  leg: LiveLeg;
  startedAt: string;
  answeredAt: string | null;
  byUserId: string;
};

/** What the mock's `core` remembers of a live call until it ends: its trace and outcome. */
type LiveMeta = {
  log: CallLogLine[];
  answeredAt: string | null;
  answeredByUserId: string | null;
  callerUserId: string | null;
  calleeUserId: string | null;
  parentCallId: string | null;
  didId: string | null;
  /** Every user it concerned, for the history's own scope and `history.appended`. */
  involved: Set<string>;
  added: Map<string, AddedParty>;
  /** The consultation's original call, for a consultation `calls.consult` started. */
  consultationOf: string | null;
};

const metas = new Map<string, LiveMeta>();
const timers = new Set<ReturnType<typeof setTimeout>>();

onDemoReset(() => {
  for (const timer of timers) {
    clearTimeout(timer);
  }
  timers.clear();
  metas.clear();
});

function later(ms: number, step: (db: Db) => void): void {
  const timer = setTimeout(() => {
    timers.delete(timer);
    step(store.db);
    touch();
  }, ms);
  timers.add(timer);
}

const nowIso = (): string => demoNowDate().toISOString();
const plusSeconds = (iso: string, seconds: number): string =>
  new Date(new Date(iso).getTime() + seconds * 1000).toISOString();
const sipUri = (db: Db, value: string): string =>
  `sip:${value}@${db.system.stack.domain}`;
const line = (
  event: string,
  detail: Record<string, unknown> = {},
  at = nowIso()
): CallLogLine => ({
  at,
  event,
  ...detail
});

const liveUser = (db: Db, id: string | undefined | null): User | undefined =>
  db.users.find(user => user.id === id && user.deletedAt === null);

const registeredDevice = (db: Db, userId: string): string | undefined =>
  db.devices.find(
    device =>
      device.userId === userId &&
      device.deletedAt === null &&
      device.lastRegisteredAt !== null
  )?.id;

function presenceStatus(db: Db, userId: string): PresenceStatus {
  if (liveUser(db, userId)?.dnd === true) {
    return 'dnd';
  }
  return db.presence[userId]?.status ?? 'offline';
}

function firstTrunkId(db: Db): string | undefined {
  return db.trunks.find(trunk => trunk.deletedAt === null)?.id;
}

/** The trunk an external leg goes out over: the first live one by priority that is not
 * unreachable; none while every trunk is down. */
function reachableTrunkId(db: Db): string | undefined {
  return db.trunks
    .filter(trunk => trunk.deletedAt === null && trunk.status !== 'unreachable')
    .toSorted((a, b) => a.priority - b.priority)[0]?.id;
}

/** The number or extension a leg stands for, as phones show it. */
function legNumber(db: Db, leg: LiveLeg): string {
  if (leg.userId !== undefined) {
    return liveUser(db, leg.userId)?.extension ?? '';
  }
  return leg.target ?? '';
}

/** Ring-group members as users, user groups expanded (§9.3). */
export function ringGroupMembers(db: Db, group: RingGroup): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const visit = (members: RingGroup['members']): void => {
    for (const member of members) {
      if (member.kind === 'user') {
        if (!out.includes(member.id)) {
          out.push(member.id);
        }
      } else if (!seen.has(member.id)) {
        seen.add(member.id);
        const userGroup = db.userGroups.find(
          candidate =>
            candidate.id === member.id && candidate.deletedAt === null
        );
        if (userGroup !== undefined) {
          visit(userGroup.members);
        }
      }
    }
  };
  visit(group.members);
  return out.filter(id => liveUser(db, id) !== undefined);
}

/** A live call's trace and outcome so far; synthesised for a call `core` already held. */
function metaOf(db: Db, call: LiveCall): LiveMeta {
  const existing = metas.get(call.callId);
  if (existing !== undefined) {
    return existing;
  }
  const callerLeg = call.legs.find(leg => leg.role === 'caller');
  const answering = call.legs.find(
    leg => leg.role === 'callee' && leg.state !== 'ringing'
  );
  const did = db.dids.find(
    candidate => candidate.number === call.to && candidate.deletedAt === null
  );
  const answeredAt =
    call.state === 'up' ? plusSeconds(call.startedAt, 6) : null;
  const log: CallLogLine[] = [];
  if (call.direction === 'inbound') {
    log.push(
      line(
        'entry',
        { did: call.to, didId: did?.id ?? null, caller: call.from },
        call.startedAt
      )
    );
    if (call.ringGroupId !== null) {
      log.push(
        line('ringGroup', { ringGroupId: call.ringGroupId }, call.startedAt)
      );
    }
    for (const leg of call.legs.filter(
      candidate => candidate.role === 'callee' && candidate.userId !== undefined
    )) {
      log.push(
        line(
          'rungDevice',
          { userId: leg.userId, ext: legNumber(db, leg) },
          plusSeconds(call.startedAt, 1)
        )
      );
    }
  } else if (call.direction === 'outbound') {
    log.push(
      line(
        'outbound',
        { userId: callerLeg?.userId, dialled: call.to },
        call.startedAt
      )
    );
    log.push(
      line(
        'attempt',
        {
          trunkId: reachableTrunkId(db) ?? firstTrunkId(db) ?? null,
          callerId:
            db.dids.find(candidate => candidate.id === db.settings.mainDidId)
              ?.number ?? null
        },
        call.startedAt
      )
    );
  } else {
    log.push(
      line(
        'internal',
        { userId: callerLeg?.userId, dialled: call.to },
        call.startedAt
      )
    );
  }
  if (answeredAt !== null) {
    log.push(
      answering?.userId !== undefined
        ? line(
            'answered',
            { userId: answering.userId, ext: legNumber(db, answering) },
            answeredAt
          )
        : line('answered', { trunkId: answering?.trunkId ?? null }, answeredAt)
    );
  }
  const meta: LiveMeta = {
    log,
    answeredAt,
    answeredByUserId: answering?.userId ?? null,
    callerUserId: callerLeg?.userId ?? null,
    calleeUserId:
      call.direction === 'inbound' && call.ringGroupId === null
        ? (answering?.userId ?? null)
        : (call.legs.find(leg => leg.role === 'callee')?.userId ?? null),
    parentCallId: null,
    didId: did?.id ?? null,
    involved: new Set(call.userIds),
    added: new Map(),
    consultationOf: null
  };
  metas.set(call.callId, meta);
  return meta;
}

function log(
  db: Db,
  call: LiveCall,
  event: string,
  detail: Record<string, unknown> = {}
): void {
  metaOf(db, call).log.push(line(event, detail));
}

function refreshUsers(db: Db, call: LiveCall): void {
  const ids = [
    ...new Set(
      call.legs
        .map(leg => leg.userId)
        .filter((id): id is string => id !== undefined)
    )
  ];
  call.userIds = ids;
  const meta = metaOf(db, call);
  for (const id of ids) {
    meta.involved.add(id);
  }
}

function peerOf(call: LiveCall): string {
  return call.direction === 'inbound' ? call.from : call.to;
}

function emitState(
  call: LiveCall,
  state: 'ringing' | 'up' | 'ended',
  extra: Iterable<string> = []
): void {
  emit(
    {
      type: 'call.state',
      callId: call.callId,
      state,
      peer: peerOf(call),
      ringGroupId: call.ringGroupId,
      userId: call.userIds[0] ?? null,
      legs: call.legs.map(leg => ({ ...leg }))
    },
    [...new Set([...call.userIds, ...extra])]
  );
}

/** A user's device-derived presence while they talk (§9.3): busy with a leg up, else available. */
function syncPresence(
  db: Db,
  userId: string,
  peer: string | null,
  ringGroupId: string | null
): void {
  const current = db.presence[userId];
  if (
    current === undefined ||
    current.status === 'offline' ||
    current.status === 'dnd'
  ) {
    return;
  }
  const talking = db.liveCalls.some(call =>
    call.legs.some(leg => leg.userId === userId && leg.state !== 'ringing')
  );
  const status: PresenceStatus = talking ? 'busy' : 'available';
  if (current.status === status) {
    return;
  }
  const entry = {
    userId,
    status,
    since: nowIso(),
    peer: talking ? peer : null,
    ringGroupId: talking ? ringGroupId : null
  };
  db.presence[userId] = entry;
  db.presenceLog.push({ ...entry });
  emit(
    {
      type: 'presence',
      userId,
      status,
      peer: entry.peer,
      ringGroupId: entry.ringGroupId
    },
    [userId]
  );
}

function syncAllPresence(
  db: Db,
  call: LiveCall,
  userIds: Iterable<string>
): void {
  for (const id of new Set(userIds)) {
    syncPresence(db, id, peerOf(call), call.ringGroupId);
  }
}

/** Appends an ended call to the history and tells the users it concerned (§10.1). */
function appendHistory(db: Db, row: Call, audience: string[]): void {
  db.calls.unshift(row);
  emit({ type: 'history.appended', callId: row.id }, audience);
}

function addedPartyRow(
  db: Db,
  call: LiveCall,
  party: AddedParty,
  endedAt: string
): Call {
  const byUser = liveUser(db, party.byUserId);
  const target = legNumber(db, party.leg);
  return {
    id: party.leg.id,
    parentCallId: call.callId,
    direction: party.leg.userId !== undefined ? 'internal' : 'outbound',
    fromUri: sipUri(db, byUser?.extension ?? ''),
    toUri: sipUri(db, target),
    didId: null,
    callerUserId: party.byUserId,
    calleeUserId: party.leg.userId ?? null,
    ringGroupId: null,
    answeredByUserId:
      party.answeredAt !== null ? (party.leg.userId ?? null) : null,
    status: party.answeredAt !== null ? 'answered' : 'missed',
    startedAt: party.startedAt,
    answeredAt: party.answeredAt,
    endedAt,
    log: [
      line(
        'addPartyTarget',
        {
          target: party.leg.userId !== undefined ? 'user' : 'external',
          parentCallId: call.callId
        },
        party.startedAt
      ),
      party.leg.userId !== undefined
        ? line(
            'rungDevice',
            { userId: party.leg.userId, ext: target },
            party.startedAt
          )
        : line(
            'attempt',
            { trunkId: party.leg.trunkId ?? null, dialled: target },
            party.startedAt
          ),
      ...(party.answeredAt !== null
        ? [
            line(
              'answered',
              party.leg.userId !== undefined
                ? { userId: party.leg.userId }
                : { trunkId: party.leg.trunkId ?? null },
              party.answeredAt
            )
          ]
        : []),
      line('ended', { by: 'callee', cause: 16 }, endedAt)
    ],
    sipTrace: [],
    qos: []
  };
}

/** Ends live call `callId`: off the live list and out of parking, into the history. */
function finishCall(
  db: Db,
  callId: string,
  outcome: {
    by: 'caller' | 'callee' | 'system';
    status?: CallStatus;
    actorUserId?: string;
  }
): void {
  const index = db.liveCalls.findIndex(
    candidate => candidate.callId === callId
  );
  if (index === -1) {
    return;
  }
  const call = db.liveCalls[index] as LiveCall;
  const meta = metaOf(db, call);
  const endedAt = nowIso();
  meta.log.push(
    line(
      'ended',
      {
        by: outcome.by,
        cause: 16,
        ...(outcome.actorUserId === undefined
          ? {}
          : { actorUserId: outcome.actorUserId })
      },
      endedAt
    )
  );
  const status: CallStatus =
    outcome.status ?? (meta.answeredAt !== null ? 'answered' : 'missed');
  const row: Call = {
    id: call.callId,
    parentCallId: meta.parentCallId,
    direction: call.direction,
    fromUri: sipUri(db, call.from),
    toUri: sipUri(db, call.to),
    didId: meta.didId,
    callerUserId: meta.callerUserId,
    calleeUserId: meta.calleeUserId,
    ringGroupId: call.ringGroupId,
    answeredByUserId: meta.answeredByUserId,
    status,
    startedAt: call.startedAt,
    answeredAt: meta.answeredAt,
    endedAt,
    log: meta.log,
    sipTrace: [],
    qos: []
  };
  db.liveCalls.splice(index, 1);
  db.parked = db.parked.filter(parked => parked.callId !== callId);
  const concerned = new Set([...meta.involved, ...call.userIds]);
  emitState(call, 'ended', concerned);
  appendHistory(db, row, [...concerned]);
  for (const party of meta.added.values()) {
    appendHistory(db, addedPartyRow(db, call, party, endedAt), [
      party.byUserId,
      ...(party.leg.userId ? [party.leg.userId] : [])
    ]);
  }
  metas.delete(callId);
  syncAllPresence(db, call, concerned);
}

/* ------------------------------------------------------------------ */
/* Dialling                                                            */
/* ------------------------------------------------------------------ */

type Resolved =
  | { kind: 'user'; user: User }
  | { kind: 'ringGroup'; group: RingGroup }
  | { kind: 'parking'; slot: string }
  | { kind: 'external'; number: string };

const problem = (
  status: 404 | 409 | 422,
  code: string,
  message: string
): ApiError => new ApiError(status, code, message);

/** What `target` dials, as a phone would: an extension, a parking slot or a number (§9.4). */
export function resolveTarget(db: Db, raw: string, field = 'target'): Resolved {
  const target = raw.trim();
  if (target === '') {
    throw invalid(field, 'invalidTarget', 'target is required');
  }
  if (/^\d+$/u.test(target)) {
    const user = db.users.find(
      candidate =>
        candidate.deletedAt === null && candidate.extension === target
    );
    if (user !== undefined) {
      return { kind: 'user', user };
    }
    const group = db.ringGroups.find(
      candidate => candidate.deletedAt === null && candidate.ext === target
    );
    if (group !== undefined) {
      return { kind: 'ringGroup', group };
    }
    if (db.parkingSlots.includes(target)) {
      return { kind: 'parking', slot: target };
    }
    if (db.settings.emergencyNumbers.includes(target)) {
      return { kind: 'external', number: target };
    }
  }
  const number = normaliseNumber(db, target);
  if (!E164.test(number)) {
    throw invalid(
      field,
      'invalidTarget',
      `'${target}' is no extension or number`,
      { target }
    );
  }
  return { kind: 'external', number };
}

const ANSWER_EXTERNAL_MS = 4000;
const ANSWER_INTERNAL_MS = 9000;
const NO_ANSWER_MS = 14_000;

/**
 * Rings `resolved` from live call `callId` with legs of `role`; on answer `onAnswer`, without one
 * `onNoAnswer`. The first answering leg wins and the others stop ringing (§9.3).
 */
function ring(
  db: Db,
  call: LiveCall,
  resolved: Exclude<Resolved, { kind: 'parking' }>,
  role: LiveLeg['role'],
  hooks: {
    onAnswer?: (db: Db, call: LiveCall, leg: LiveLeg) => void;
    onNoAnswer: (db: Db, call: LiveCall) => void;
  }
): LiveLeg[] {
  const legs: LiveLeg[] = [];
  if (resolved.kind === 'external') {
    const trunkId = reachableTrunkId(db);
    if (trunkId === undefined) {
      // No trunk reachable: the leg is never placed and the call ends unanswered.
      log(db, call, 'attempt', {
        trunkId: firstTrunkId(db) ?? null,
        dialled: resolved.number,
        result: 'trunkUnreachable'
      });
    } else {
      legs.push({
        id: newId(),
        role,
        state: 'ringing',
        trunkId,
        target: resolved.number
      });
      log(db, call, 'attempt', { trunkId, dialled: resolved.number });
    }
  } else {
    const userIds =
      resolved.kind === 'user'
        ? [resolved.user.id]
        : ringGroupMembers(db, resolved.group);
    if (resolved.kind === 'ringGroup') {
      call.ringGroupId = resolved.group.id;
      log(db, call, 'ringGroup', {
        ringGroupId: resolved.group.id,
        strategy: resolved.group.strategy
      });
    }
    for (const userId of userIds) {
      const ext = liveUser(db, userId)?.extension ?? '';
      const status = presenceStatus(db, userId);
      const deviceId = registeredDevice(db, userId);
      if (status === 'dnd') {
        log(db, call, 'skipped', { userId, ext, reason: 'dnd' });
      } else if (
        resolved.kind === 'ringGroup' &&
        resolved.group.skipBusy &&
        status === 'busy'
      ) {
        log(db, call, 'skipped', { userId, ext, reason: 'busy' });
      } else if (deviceId === undefined) {
        log(db, call, 'rungDevice', {
          userId,
          ext,
          result: 'noRegisteredDevice'
        });
      } else {
        legs.push({ id: newId(), role, state: 'ringing', userId, deviceId });
        log(db, call, 'rungDevice', { userId, ext });
      }
    }
  }
  call.legs.push(...legs);
  refreshUsers(db, call);
  const ids = legs.map(leg => leg.id);
  const answerer =
    resolved.kind === 'external'
      ? legs[0]
      : legs.find(
          leg =>
            leg.userId !== undefined &&
            presenceStatus(db, leg.userId) === 'available'
        );
  const giveUp = (current: Db): void => {
    const live = current.liveCalls.find(
      candidate => candidate.callId === call.callId
    );
    // A ring that placed no leg (no reachable trunk, every member skipped) gives up all the same.
    if (
      live === undefined ||
      (ids.length > 0 &&
        !live.legs.some(leg => ids.includes(leg.id) && leg.state === 'ringing'))
    ) {
      return;
    }
    live.legs = live.legs.filter(
      leg => !(ids.includes(leg.id) && leg.state === 'ringing')
    );
    refreshUsers(current, live);
    log(
      current,
      live,
      resolved.kind === 'ringGroup' ? 'unanswered' : 'noAnswer',
      resolved.kind === 'ringGroup'
        ? { ringGroupId: resolved.group.id }
        : resolved.kind === 'user'
          ? { userId: resolved.user.id }
          : {}
    );
    hooks.onNoAnswer(current, live);
  };
  if (legs.length === 0) {
    later(1500, giveUp);
    return legs;
  }
  if (answerer === undefined) {
    later(NO_ANSWER_MS, giveUp);
    return legs;
  }
  later(
    resolved.kind === 'external' ? ANSWER_EXTERNAL_MS : ANSWER_INTERNAL_MS,
    current => {
      const live = current.liveCalls.find(
        candidate => candidate.callId === call.callId
      );
      const leg = live?.legs.find(candidate => candidate.id === answerer.id);
      if (live === undefined || leg === undefined || leg.state !== 'ringing') {
        return;
      }
      answerLeg(current, live, leg, ids);
      hooks.onAnswer?.(current, live, leg);
    }
  );
  return legs;
}

/** Leg `leg` answers: its ring rivals stop, the call is up. */
function answerLeg(
  db: Db,
  call: LiveCall,
  leg: LiveLeg,
  rivals: string[] = []
): void {
  leg.state = 'up';
  call.legs = call.legs.filter(
    other =>
      other.id === leg.id ||
      !(rivals.includes(other.id) && other.state === 'ringing')
  );
  const meta = metaOf(db, call);
  if (leg.role === 'added') {
    const party = meta.added.get(leg.id);
    if (party !== undefined) {
      party.answeredAt = nowIso();
    }
  } else if (leg.role === 'callee' && meta.answeredAt === null) {
    meta.answeredAt = nowIso();
    meta.answeredByUserId = leg.userId ?? null;
  }
  log(
    db,
    call,
    'answered',
    leg.userId !== undefined
      ? { userId: leg.userId, ext: legNumber(db, leg) }
      : { trunkId: leg.trunkId ?? null }
  );
  if (
    call.legs.some(
      other => other.role === 'caller' && other.state !== 'ringing'
    )
  ) {
    call.state = 'up';
  }
  refreshUsers(db, call);
  emitState(call, call.state);
  syncAllPresence(db, call, call.userIds);
}

/** A new live call, its own `calls` row from the start. */
function newLiveCall(
  db: Db,
  fields: Pick<LiveCall, 'direction' | 'from' | 'to' | 'legs'> & {
    state?: LiveCall['state'];
  },
  meta: Partial<LiveMeta>
): LiveCall {
  const call: LiveCall = {
    callId: newId(),
    direction: fields.direction,
    from: fields.from,
    to: fields.to,
    state: fields.state ?? 'ringing',
    startedAt: nowIso(),
    ringGroupId: null,
    userIds: [],
    legs: fields.legs
  };
  metas.set(call.callId, {
    log: [],
    answeredAt: null,
    answeredByUserId: null,
    callerUserId: null,
    calleeUserId: null,
    parentCallId: null,
    didId: null,
    involved: new Set(),
    added: new Map(),
    consultationOf: null,
    ...meta
  });
  db.liveCalls.unshift(call);
  refreshUsers(db, call);
  return call;
}

function directionFor(resolved: Resolved, fromTrunk: boolean): CallDirection {
  if (resolved.kind === 'external') {
    return 'outbound';
  }
  return fromTrunk ? 'inbound' : 'internal';
}

function targetLabel(resolved: Resolved): string {
  switch (resolved.kind) {
    case 'user':
      return resolved.user.extension ?? '';
    case 'ringGroup':
      return resolved.group.ext;
    case 'parking':
      return resolved.slot;
    case 'external':
      return resolved.number;
  }
}

function calleeUserIdOf(resolved: Resolved): string | null {
  return resolved.kind === 'user' ? resolved.user.id : null;
}

/* ------------------------------------------------------------------ */
/* Leg selection (§10.3 "Live calls")                                  */
/* ------------------------------------------------------------------ */

function liveCall(ctx: Ctx, id: string): LiveCall {
  const call = ctx.db.liveCalls.find(candidate => candidate.callId === id);
  if (call === undefined) {
    throw notFound('call', id);
  }
  return call;
}

/** The leg `legId` names, or the actor's other party; 422 when the actor is not in the call. */
function partyLeg(
  ctx: Ctx,
  call: LiveCall,
  legId: string | undefined
): LiveLeg {
  if (legId !== undefined) {
    const leg = call.legs.find(candidate => candidate.id === legId);
    if (leg === undefined) {
      throw problem(404, 'legNotFound', `leg '${legId}' is not in this call`);
    }
    return leg;
  }
  const own = call.legs.find(
    leg =>
      leg.userId === ctx.actor.id &&
      (leg.role === 'caller' || leg.state !== 'ringing')
  );
  if (own === undefined) {
    throw problem(
      422,
      'legRequired',
      'calls: you are not in this call; name the leg with legId'
    );
  }
  const other =
    call.legs.find(leg => leg !== own && leg.role !== 'added') ??
    call.legs.find(leg => leg !== own);
  if (other === undefined) {
    throw problem(409, 'notBridged', 'calls: the call has no other party');
  }
  return other;
}

function requireBridged(leg: LiveLeg): void {
  if (leg.role === 'added') {
    throw problem(
      409,
      'notBridged',
      'calls: an added party is not bridged for this'
    );
  }
  if (leg.state === 'ringing') {
    throw problem(409, 'legNotUp', 'calls: the leg still rings');
  }
}

/** The leg on the other side of `party`: the holder, parker or transferrer. */
function otherSide(call: LiveCall, party: LiveLeg): LiveLeg | undefined {
  return call.legs.find(
    leg => leg !== party && leg.role !== 'added' && leg.state !== 'ringing'
  );
}

function requireDevice(db: Db, userId: string): string {
  const device = registeredDevice(db, userId);
  if (device === undefined) {
    throw problem(409, 'noRegisteredDevice', 'calls: no registered device');
  }
  return device;
}

/* ------------------------------------------------------------------ */
/* Operations                                                          */
/* ------------------------------------------------------------------ */

const ownActingUser = (ctx: Ctx, input: { userId?: string }): boolean =>
  input.userId === undefined || input.userId === ctx.actor.id;

const ownLiveCall = (ctx: Ctx, input: { id: string }): boolean =>
  isOwnLive(ctx.db, input.id, ctx.actor.id);

function matchesLive(
  call: LiveCall,
  input: ListInput,
  ownUserId: string | null
): boolean {
  if (input.direction !== undefined && call.direction !== input.direction) {
    return false;
  }
  if (
    input.ringGroupId !== undefined &&
    call.ringGroupId !== input.ringGroupId
  ) {
    return false;
  }
  if (input.userId !== undefined && !call.userIds.includes(input.userId)) {
    return false;
  }
  return ownUserId === null || call.userIds.includes(ownUserId);
}

defineOp<ListInput, Page<CallOut> | Page<LiveCall>>({
  name: 'calls.list',
  minRole: 'user',
  scope: ownActingUser,
  readOnly: true,
  run: (ctx, input) => {
    const ownUserId = ctx.actor.role === 'user' ? ctx.actor.id : null;
    if (input.live === true) {
      return paginate(
        ctx.operation,
        ctx.db.liveCalls.filter(call => matchesLive(call, input, ownUserId)),
        input
      );
    }
    const from =
      input.from === undefined
        ? null
        : requireInstant(ctx.db, 'from', input.from);
    const to =
      input.to === undefined
        ? null
        : requireInstant(ctx.db, 'to', input.to, true);
    const rows = ctx.db.calls
      .filter(call => {
        const started = new Date(call.startedAt).getTime();
        return (
          call.endedAt !== null &&
          (input.direction === undefined ||
            call.direction === input.direction) &&
          (input.status === undefined || call.status === input.status) &&
          (input.ringGroupId === undefined ||
            call.ringGroupId === input.ringGroupId) &&
          (input.parentCallId === undefined ||
            call.parentCallId === input.parentCallId) &&
          (from === null || started >= from) &&
          (to === null || started < to) &&
          (input.userId === undefined || isOwnCall(call, input.userId)) &&
          (ownUserId === null || isOwnCall(call, ownUserId))
        );
      })
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
      .map(toCallOut);
    return paginate(ctx.operation, rows, input);
  }
});

function endedCall(db: Db, id: string): Call {
  const call = db.calls.find(
    candidate => candidate.id === id && candidate.endedAt !== null
  );
  if (call === undefined) {
    throw notFound('call', id);
  }
  return call;
}

defineOp<{ id: string }, CallDetail>({
  name: 'calls.get',
  minRole: 'user',
  scope: (ctx, input) => isOwnCall(endedCall(ctx.db, input.id), ctx.actor.id),
  readOnly: true,
  run: (ctx, input) => {
    const call = endedCall(ctx.db, input.id);
    const children = ctx.db.calls
      .filter(
        child =>
          child.parentCallId === call.id &&
          child.endedAt !== null &&
          (ctx.actor.role !== 'user' || isOwnCall(child, ctx.actor.id))
      )
      .sort((a, b) => a.startedAt.localeCompare(b.startedAt));
    return { ...call, childCallIds: children.map(child => child.id) };
  }
});

/** Retrieves the call parked on `slot` to `userId`'s phones (§10.2 "Call parking"). */
function retrieveParked(
  ctx: Ctx,
  slot: string,
  userId: string,
  deviceId: string
): { callId: string } {
  const parked = ctx.db.parked.find(entry => entry.slot === slot);
  const call =
    parked === undefined
      ? undefined
      : ctx.db.liveCalls.find(candidate => candidate.callId === parked.callId);
  if (parked === undefined || call === undefined) {
    throw problem(409, 'slotEmpty', `calls: no call is parked on ${slot}`);
  }
  ctx.db.parked = ctx.db.parked.filter(entry => entry.slot !== slot);
  const leg: LiveLeg = {
    id: newId(),
    role: 'callee',
    state: 'ringing',
    userId,
    deviceId
  };
  call.legs.push(leg);
  log(ctx.db, call, 'parkingRetrieved', { ext: slot, by: userId });
  refreshUsers(ctx.db, call);
  emitState(call, call.state);
  later(1500, db => {
    const live = db.liveCalls.find(
      candidate => candidate.callId === call.callId
    );
    const own = live?.legs.find(candidate => candidate.id === leg.id);
    if (live === undefined || own === undefined) {
      return;
    }
    own.state = 'up';
    for (const other of live.legs) {
      if (other.state === 'held') {
        other.state = 'up';
      }
    }
    log(db, live, 'answered', {
      userId,
      ext: liveUser(db, userId)?.extension ?? ''
    });
    refreshUsers(db, live);
    emitState(live, 'up');
    syncAllPresence(db, live, live.userIds);
  });
  return { callId: call.callId };
}

defineOp<
  { target: string; userId?: string; clir?: boolean },
  { callId: string }
>({
  name: 'calls.originate',
  minRole: 'user',
  scope: ownActingUser,
  run: (ctx, input) => {
    const userId = input.userId ?? ctx.actor.id;
    const user = liveUser(ctx.db, userId);
    if (user === undefined) {
      throw notFound('user', userId);
    }
    if (user.extension === null) {
      throw problem(
        409,
        'noRegisteredDevice',
        'calls: the user has no extension'
      );
    }
    const resolved = resolveTarget(ctx.db, input.target);
    if (resolved.kind === 'user' && resolved.user.id === userId) {
      throw invalid(
        'target',
        'invalidTarget',
        'calls: you cannot call yourself',
        { target: input.target }
      );
    }
    const deviceId = registeredDevice(ctx.db, userId);
    if (deviceId === undefined) {
      // The attempt still reaches the history with its trace line (§10.2 "Click-to-dial"), after
      // `call` has rolled the refused operation back.
      const attempt = failedAttempt(ctx, user, input, resolved);
      queueMicrotask(() => {
        appendHistory(store.db, attempt, [user.id]);
        touch();
      });
      throw problem(409, 'noRegisteredDevice', 'calls: no registered device');
    }
    if (resolved.kind === 'parking') {
      return retrieveParked(ctx, resolved.slot, userId, deviceId);
    }
    const callerLeg: LiveLeg = {
      id: newId(),
      role: 'caller',
      state: 'ringing',
      userId,
      deviceId
    };
    const call = newLiveCall(
      ctx.db,
      {
        direction: directionFor(resolved, false),
        from: user.extension,
        to: targetLabel(resolved),
        legs: [callerLeg]
      },
      { callerUserId: userId, calleeUserId: calleeUserIdOf(resolved) }
    );
    log(ctx.db, call, 'originate', {
      actorUserId: ctx.actor.id,
      target: input.target,
      ...(input.clir === undefined ? {} : { clir: input.clir })
    });
    log(ctx.db, call, 'rungDevice', {
      userId,
      ext: user.extension,
      step: 'originate'
    });
    emitState(call, 'ringing');
    later(1500, db => {
      const live = db.liveCalls.find(
        candidate => candidate.callId === call.callId
      );
      const leg = live?.legs.find(candidate => candidate.id === callerLeg.id);
      if (live === undefined || leg === undefined) {
        return;
      }
      leg.state = 'up';
      log(db, live, 'deviceAnswered', { userId, ext: user.extension });
      syncPresence(db, userId, targetLabel(resolved), null);
      ring(db, live, resolved, 'callee', {
        onNoAnswer: (current, ended) =>
          finishCall(current, ended.callId, { by: 'system', status: 'missed' })
      });
      emitState(live, live.state);
    });
    return { callId: call.callId };
  }
});

function failedAttempt(
  ctx: Ctx,
  user: User,
  input: { target: string; clir?: boolean },
  resolved: Resolved
): Call {
  return {
    id: newId(),
    parentCallId: null,
    direction: directionFor(resolved, false),
    fromUri: sipUri(ctx.db, user.extension ?? ''),
    toUri: sipUri(ctx.db, targetLabel(resolved)),
    didId: null,
    callerUserId: user.id,
    calleeUserId: calleeUserIdOf(resolved),
    ringGroupId: null,
    answeredByUserId: null,
    status: 'failed',
    startedAt: ctx.now,
    answeredAt: null,
    endedAt: ctx.now,
    log: [
      line(
        'originate',
        { actorUserId: ctx.actor.id, target: input.target },
        ctx.now
      ),
      line(
        'originate',
        { result: 'noRegisteredDevice', userId: user.id },
        ctx.now
      ),
      line('ended', { by: 'system', cause: 0 }, ctx.now)
    ],
    sipTrace: [],
    qos: []
  };
}

type LegInput = { id: string; legId?: string };

defineOp<LegInput, { id: string }>({
  name: 'calls.hold',
  minRole: 'user',
  scope: ownLiveCall,
  run: (ctx, input) => {
    const call = liveCall(ctx, input.id);
    const party = partyLeg(ctx, call, input.legId);
    requireBridged(party);
    if (party.state === 'held') {
      throw problem(409, 'held', 'calls: already on hold');
    }
    party.state = 'held';
    log(ctx.db, call, 'hold', {
      actorUserId: ctx.actor.id,
      channelId: party.id
    });
    emitState(call, call.state);
    return { id: call.callId };
  }
});

defineOp<{ id: string }, { id: string }>({
  name: 'calls.resume',
  minRole: 'user',
  scope: ownLiveCall,
  run: (ctx, input) => {
    const call = liveCall(ctx, input.id);
    const held = call.legs.filter(leg => leg.state === 'held');
    if (held.length === 0) {
      throw problem(409, 'notHeld', 'calls: nobody is on hold');
    }
    // During a consultation all three talk: the consulted party joins this call.
    const consultation = findConsultation(ctx.db, call.callId);
    for (const leg of held) {
      leg.state = 'up';
    }
    log(ctx.db, call, 'resume', { actorUserId: ctx.actor.id });
    if (consultation !== undefined) {
      const joining = consultation.legs.filter(
        leg =>
          leg.state !== 'ringing' &&
          !(
            leg.userId !== undefined &&
            call.legs.some(own => own.userId === leg.userId)
          )
      );
      for (const leg of joining) {
        const moved: LiveLeg = { ...leg, role: 'added' };
        call.legs.push(moved);
        metaOf(ctx.db, call).added.set(moved.id, {
          leg: moved,
          startedAt: consultation.startedAt,
          answeredAt: metas.get(consultation.callId)?.answeredAt ?? null,
          byUserId: ctx.actor.id
        });
      }
      consultation.legs = consultation.legs.filter(
        leg => !joining.includes(leg)
      );
      log(ctx.db, consultation, 'attendedTransfer', {
        actorUserId: ctx.actor.id,
        result: 'joined',
        parentCallId: call.callId
      });
      finishCall(ctx.db, consultation.callId, {
        by: 'system',
        status: 'answered'
      });
      refreshUsers(ctx.db, call);
    }
    emitState(call, call.state);
    return { id: call.callId };
  }
});

defineOp<LegInput & { target: string }, { id: string; callId: string }>({
  name: 'calls.consult',
  minRole: 'user',
  scope: ownLiveCall,
  run: (ctx, input) => {
    const call = liveCall(ctx, input.id);
    const party = partyLeg(ctx, call, input.legId);
    requireBridged(party);
    if (findConsultation(ctx.db, call.callId) !== undefined) {
      throw problem(
        409,
        'consulting',
        'calls: a consultation is already running'
      );
    }
    const side = otherSide(call, party);
    const dialler = liveUser(ctx.db, side?.userId);
    if (dialler === undefined || dialler.extension === null) {
      throw problem(
        409,
        'notInCall',
        'calls: no user on the other side to consult from'
      );
    }
    const resolved = resolveTarget(ctx.db, input.target);
    if (
      resolved.kind === 'parking' ||
      (resolved.kind === 'user' && resolved.user.id === dialler.id)
    ) {
      throw invalid(
        'target',
        'invalidTarget',
        'calls: not a consultation target',
        { target: input.target }
      );
    }
    party.state = 'held';
    log(ctx.db, call, 'hold', {
      actorUserId: ctx.actor.id,
      channelId: party.id,
      step: 'consult'
    });
    const consultation = newLiveCall(
      ctx.db,
      {
        direction: directionFor(resolved, false),
        from: dialler.extension,
        to: targetLabel(resolved),
        legs: [
          {
            id: newId(),
            role: 'caller',
            state: 'up',
            userId: dialler.id,
            ...(side?.deviceId ? { deviceId: side.deviceId } : {})
          }
        ]
      },
      {
        callerUserId: dialler.id,
        calleeUserId: calleeUserIdOf(resolved),
        consultationOf: call.callId,
        parentCallId: call.callId
      }
    );
    log(ctx.db, consultation, 'consult', {
      actorUserId: ctx.actor.id,
      parentCallId: call.callId,
      target: input.target
    });
    ring(ctx.db, consultation, resolved, 'callee', {
      onNoAnswer: (db, ended) =>
        finishCall(db, ended.callId, { by: 'system', status: 'missed' })
    });
    emitState(call, call.state);
    emitState(consultation, 'ringing');
    return { id: call.callId, callId: consultation.callId };
  }
});

defineOp<{ id: string; target: string }, { id: string; callId: string }>({
  name: 'calls.addParty',
  minRole: 'user',
  scope: ownLiveCall,
  run: (ctx, input) => {
    const call = liveCall(ctx, input.id);
    if (call.state !== 'up') {
      throw problem(409, 'notAnswered', 'calls: the call is not answered yet');
    }
    const resolved = resolveTarget(ctx.db, input.target);
    if (resolved.kind === 'parking') {
      throw invalid(
        'target',
        'invalidTarget',
        'calls: a parking slot cannot join a call',
        { target: input.target }
      );
    }
    if (
      resolved.kind === 'user' &&
      call.legs.some(leg => leg.userId === resolved.user.id)
    ) {
      throw invalid('target', 'invalidTarget', 'calls: already in this call', {
        target: input.target
      });
    }
    const target = resolved.kind === 'ringGroup' ? null : resolved;
    if (target === null) {
      throw invalid(
        'target',
        'invalidTarget',
        'calls: an added party is one person or number',
        { target: input.target }
      );
    }
    log(ctx.db, call, 'addPartyTarget', {
      actorUserId: ctx.actor.id,
      target: input.target
    });
    const startedAt = ctx.now;
    const legs = ring(ctx.db, call, target, 'added', {
      onNoAnswer: db => {
        const live = db.liveCalls.find(
          candidate => candidate.callId === call.callId
        );
        if (live !== undefined) {
          emitState(live, live.state);
        }
      }
    });
    const leg = legs[0];
    if (leg === undefined) {
      throw problem(
        409,
        'noRegisteredDevice',
        'calls: the party has no registered device'
      );
    }
    metaOf(ctx.db, call).added.set(leg.id, {
      leg,
      startedAt,
      answeredAt: null,
      byUserId: ctx.actor.id
    });
    emitState(call, call.state);
    return { id: call.callId, callId: leg.id };
  }
});

defineOp<
  LegInput & { target?: string; voicemail?: boolean; toCallId?: string },
  { id: string }
>({
  name: 'calls.transfer',
  minRole: 'user',
  scope: (ctx, input) =>
    isOwnLive(ctx.db, input.id, ctx.actor.id) &&
    (input.toCallId === undefined ||
      isOwnLive(ctx.db, input.toCallId, ctx.actor.id)),
  run: (ctx, input) => {
    const call = liveCall(ctx, input.id);
    if (input.target !== undefined && input.toCallId === undefined) {
      blindTransfer(
        ctx,
        call,
        input.target,
        input.voicemail === true,
        input.legId
      );
      return { id: call.callId };
    }
    if (
      input.toCallId !== undefined &&
      input.target === undefined &&
      input.voicemail === undefined
    ) {
      attendedTransfer(ctx, call, input.toCallId, input.legId);
      return { id: call.callId };
    }
    throw invalid(
      'target',
      'transferInput',
      'calls: give either target (with voicemail, if wanted) or toCallId'
    );
  }
});

function blindTransfer(
  ctx: Ctx,
  call: LiveCall,
  rawTarget: string,
  voicemail: boolean,
  legId: string | undefined
): void {
  const party = partyLeg(ctx, call, legId);
  requireBridged(party);
  const resolved = resolveTarget(ctx.db, rawTarget);
  if (resolved.kind === 'parking') {
    throw invalid('target', 'invalidTarget', 'calls: park the call instead', {
      target: rawTarget
    });
  }
  const mailbox =
    resolved.kind === 'user' && resolved.user.mailboxEnabled
      ? { userId: resolved.user.id }
      : resolved.kind === 'ringGroup' && resolved.group.mailboxEnabled
        ? { ringGroupId: resolved.group.id }
        : null;
  if (voicemail && mailbox === null) {
    throw invalid(
      'target',
      'noMailbox',
      'calls: nobody owning that extension has a mailbox',
      { target: rawTarget }
    );
  }
  log(ctx.db, call, 'transfer', {
    actorUserId: ctx.actor.id,
    target: rawTarget,
    ...(voicemail ? { voicemail: true } : {}),
    transferee: party.id
  });
  call.legs = call.legs.filter(leg => leg === party);
  finishCall(ctx.db, call.callId, { by: 'callee', actorUserId: ctx.actor.id });
  const moved: LiveLeg = { ...party, role: 'caller', state: 'up' };
  const onward = newLiveCall(
    ctx.db,
    {
      direction: voicemail
        ? party.trunkId !== undefined
          ? 'inbound'
          : 'internal'
        : directionFor(resolved, party.trunkId !== undefined),
      from: legNumber(ctx.db, party),
      to: targetLabel(resolved),
      legs: [moved],
      state: 'ringing'
    },
    {
      callerUserId: party.userId ?? null,
      calleeUserId: calleeUserIdOf(resolved),
      parentCallId: call.callId
    }
  );
  log(ctx.db, onward, 'transferredFrom', {
    parentCallId: call.callId,
    actorUserId: ctx.actor.id
  });
  if (voicemail && mailbox !== null) {
    log(ctx.db, onward, 'mailbox', { ...mailbox, reason: 'transfer' });
    emitState(onward, 'ringing', mailbox.userId ? [mailbox.userId] : []);
    later(12_000, db =>
      finishCall(db, onward.callId, { by: 'caller', status: 'voicemail' })
    );
    return;
  }
  if (resolved.kind === 'ringGroup') {
    onward.ringGroupId = resolved.group.id;
  }
  ring(ctx.db, onward, resolved, 'callee', {
    onNoAnswer: (db, ended) =>
      finishCall(db, ended.callId, { by: 'system', status: 'missed' })
  });
  emitState(onward, 'ringing');
}

function attendedTransfer(
  ctx: Ctx,
  call: LiveCall,
  toCallId: string,
  legId: string | undefined
): void {
  const consultation = liveCall(ctx, toCallId);
  if (findConsultation(ctx.db, call.callId)?.callId !== consultation.callId) {
    throw problem(
      409,
      'notConsultation',
      'calls: toCallId is not this call’s consultation'
    );
  }
  const held = call.legs.find(leg => leg.state === 'held');
  if (held === undefined || (legId !== undefined && held.id !== legId)) {
    throw problem(
      409,
      'notHeld',
      'calls: the party to transfer is not on hold'
    );
  }
  const consulted = consultation.legs.find(leg => leg.role === 'callee');
  if (consulted === undefined || consulted.state !== 'up') {
    throw problem(
      409,
      'notAnswered',
      'calls: the consultation is not answered yet'
    );
  }
  const transferrer = otherSide(call, held);
  log(ctx.db, call, 'attendedTransfer', {
    actorUserId: ctx.actor.id,
    toCallId: consultation.callId,
    transferee: held.id
  });
  log(ctx.db, consultation, 'attendedTransfer', {
    actorUserId: ctx.actor.id,
    parentCallId: call.callId
  });
  held.state = 'up';
  call.legs = call.legs.filter(leg => leg !== transferrer);
  call.legs.push({
    ...consulted,
    role: transferrer?.role === 'caller' ? 'caller' : 'callee'
  });
  consultation.legs = consultation.legs.filter(leg => leg !== consulted);
  finishCall(ctx.db, consultation.callId, {
    by: 'caller',
    status: 'answered',
    actorUserId: ctx.actor.id
  });
  refreshUsers(ctx.db, call);
  emitState(call, call.state, transferrer?.userId ? [transferrer.userId] : []);
  syncAllPresence(ctx.db, call, [
    ...call.userIds,
    ...(transferrer?.userId ? [transferrer.userId] : [])
  ]);
}

defineOp<LegInput, { id: string; slot: string }>({
  name: 'calls.park',
  minRole: 'user',
  scope: ownLiveCall,
  run: (ctx, input) => {
    const call = liveCall(ctx, input.id);
    const party = partyLeg(ctx, call, input.legId);
    requireBridged(party);
    const parker = otherSide(call, party);
    if (parker?.userId === undefined) {
      throw problem(409, 'noParker', 'calls: the other side is no user');
    }
    const taken = new Set(ctx.db.parked.map(entry => entry.slot));
    const slot = [...ctx.db.parkingSlots]
      .sort()
      .find(candidate => !taken.has(candidate));
    if (slot === undefined) {
      throw problem(409, 'noFreeSlot', 'calls: every parking slot is taken');
    }
    party.state = 'held';
    call.legs = call.legs.filter(leg => leg === party);
    log(ctx.db, call, 'parked', {
      by: parker.userId,
      ext: slot,
      actorUserId: ctx.actor.id
    });
    ctx.db.parked.push({
      slot,
      callId: call.callId,
      from: legNumber(ctx.db, party),
      parkedByUserId: parker.userId,
      parkedAt: ctx.now
    });
    refreshUsers(ctx.db, call);
    emitState(call, call.state, [parker.userId]);
    syncPresence(ctx.db, parker.userId, null, null);
    return { id: call.callId, slot };
  }
});

defineOp<{ id: string }, { id: string }>({
  name: 'calls.pickup',
  minRole: 'user',
  scope: 'any',
  run: (ctx, input) => {
    const call = liveCall(ctx, input.id);
    const ringing = call.legs.filter(
      leg => leg.role === 'callee' && leg.state === 'ringing'
    );
    if (call.state !== 'ringing' || ringing.length === 0) {
      throw problem(409, 'notRinging', 'calls: the call rings nobody');
    }
    const deviceId = requireDevice(ctx.db, ctx.actor.id);
    log(ctx.db, call, 'pickup', {
      userId: ctx.actor.id,
      ext: liveUser(ctx.db, ctx.actor.id)?.extension ?? ''
    });
    call.legs = call.legs.filter(leg => !ringing.includes(leg));
    const leg: LiveLeg = {
      id: newId(),
      role: 'callee',
      state: 'ringing',
      userId: ctx.actor.id,
      deviceId
    };
    call.legs.push(leg);
    answerLeg(ctx.db, call, leg);
    return { id: call.callId };
  }
});

defineOp<{ id: string }, { id: string }>({
  name: 'calls.decline',
  minRole: 'user',
  scope: 'any',
  run: (ctx, input) => {
    const call = liveCall(ctx, input.id);
    const own = call.legs.filter(
      leg =>
        leg.userId === ctx.actor.id &&
        leg.state === 'ringing' &&
        leg.role !== 'caller'
    );
    if (own.length === 0) {
      throw problem(409, 'notRinging', 'calls: nothing rings for you');
    }
    call.legs = call.legs.filter(leg => !own.includes(leg));
    log(ctx.db, call, 'declined', { userId: ctx.actor.id });
    refreshUsers(ctx.db, call);
    const stillRinging = call.legs.some(
      leg => leg.state === 'ringing' && leg.role !== 'caller'
    );
    if (!stillRinging && call.state === 'ringing') {
      const meta = metaOf(ctx.db, call);
      const callee = liveUser(ctx.db, meta.calleeUserId);
      const group = ctx.db.ringGroups.find(
        candidate => candidate.id === call.ringGroupId
      );
      const mailbox =
        callee?.mailboxEnabled === true
          ? { userId: callee.id }
          : group?.mailboxEnabled === true
            ? { ringGroupId: group.id }
            : null;
      if (mailbox !== null) {
        log(ctx.db, call, 'mailbox', { ...mailbox, reason: 'declined' });
        emitState(call, 'ringing', [ctx.actor.id]);
        later(10_000, db =>
          finishCall(db, call.callId, { by: 'caller', status: 'voicemail' })
        );
      } else {
        finishCall(ctx.db, call.callId, { by: 'system', status: 'missed' });
      }
    } else {
      emitState(call, call.state, [ctx.actor.id]);
    }
    return { id: call.callId };
  }
});

defineOp<{ id: string; legId?: string }, { id: string }>({
  name: 'calls.hangup',
  minRole: 'user',
  scope: ownLiveCall,
  run: (ctx, input) => {
    const call = liveCall(ctx, input.id);
    if (input.legId !== undefined) {
      const leg = call.legs.find(candidate => candidate.id === input.legId);
      if (leg === undefined) {
        throw problem(
          404,
          'legNotFound',
          `leg '${input.legId}' is not in this call`
        );
      }
      log(ctx.db, call, 'hangup', { actorUserId: ctx.actor.id, legId: leg.id });
      const remaining = call.legs.filter(
        candidate => candidate !== leg && candidate.role !== 'added'
      );
      if (leg.role === 'added' || remaining.length >= 2) {
        call.legs = call.legs.filter(candidate => candidate !== leg);
        const meta = metaOf(ctx.db, call);
        const party = meta.added.get(leg.id);
        if (party !== undefined) {
          meta.added.delete(leg.id);
          appendHistory(ctx.db, addedPartyRow(ctx.db, call, party, ctx.now), [
            party.byUserId,
            ...(leg.userId ? [leg.userId] : [])
          ]);
        }
        refreshUsers(ctx.db, call);
        emitState(call, call.state, leg.userId ? [leg.userId] : []);
        if (leg.userId !== undefined) {
          syncPresence(ctx.db, leg.userId, null, null);
        }
        return { id: call.callId };
      }
      finishCall(ctx.db, call.callId, {
        by: leg.role === 'caller' ? 'caller' : 'callee',
        actorUserId: ctx.actor.id
      });
      return { id: call.callId };
    }
    log(ctx.db, call, 'hangup', { actorUserId: ctx.actor.id });
    const own = call.legs.find(leg => leg.userId === ctx.actor.id);
    finishCall(ctx.db, call.callId, {
      by:
        own === undefined
          ? 'system'
          : own.role === 'caller'
            ? 'caller'
            : 'callee',
      actorUserId: ctx.actor.id
    });
    return { id: call.callId };
  }
});

/**
 * The consultation `calls.consult` started from live call `callId`: the one it remembers, or — for
 * a call `core` held before this page loaded — a later call the holding user placed while the
 * other party waits on hold, as a phone pairs them.
 */
export function findConsultation(db: Db, callId: string): LiveCall | undefined {
  const original = db.liveCalls.find(candidate => candidate.callId === callId);
  if (original === undefined) {
    return undefined;
  }
  const remembered = db.liveCalls.find(
    candidate => metas.get(candidate.callId)?.consultationOf === callId
  );
  if (remembered !== undefined) {
    return remembered;
  }
  if (!original.legs.some(leg => leg.state === 'held')) {
    return undefined;
  }
  const holders = original.legs
    .filter(leg => leg.userId !== undefined && leg.state === 'up')
    .map(leg => leg.userId as string);
  return db.liveCalls
    .filter(
      candidate =>
        candidate.callId !== callId &&
        candidate.startedAt >= original.startedAt &&
        !db.parked.some(entry => entry.callId === candidate.callId) &&
        candidate.legs.some(
          leg =>
            leg.role === 'caller' &&
            leg.userId !== undefined &&
            holders.includes(leg.userId)
        )
    )
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0];
}

/** The live call whose consultation `callId` is, if it is one. */
export function consultationOriginal(
  db: Db,
  callId: string
): LiveCall | undefined {
  return db.liveCalls.find(
    candidate =>
      candidate.callId !== callId &&
      findConsultation(db, candidate.callId)?.callId === callId
  );
}

/** For tests: whether a live action timer is pending. */
export const pendingTimers = (): number => timers.size;

/* ------------------------------------------------------------------ */
/* Rings that outlived the page                                        */
/* ------------------------------------------------------------------ */

const STALE_RING_MS = 60_000;
const SWEEP_MS = 5000;

/**
 * Ends the live calls still ringing a minute after they started: their ring timers lived in a page
 * that has since reloaded, and no phone rings that long (`core` gives up after the ring timeouts).
 */
export function endStaleRings(db: Db, now = demoNow()): number {
  const stale = db.liveCalls.filter(
    call =>
      call.state === 'ringing' &&
      now - Date.parse(call.startedAt) > STALE_RING_MS &&
      !db.parked.some(entry => entry.callId === call.callId)
  );
  for (const call of stale) {
    log(db, call, 'noAnswer');
    finishCall(db, call.callId, { by: 'system', status: 'missed' });
  }
  return stale.length;
}

if (typeof window !== 'undefined' && import.meta.env.MODE !== 'test') {
  setInterval(() => {
    if (endStaleRings(store.db) > 0) {
      touch();
    }
  }, SWEEP_MS);
}
