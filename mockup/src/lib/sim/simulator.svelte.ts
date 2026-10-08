/**
 * The event simulator: plays the part of `core`, the PBX process that places calls (spec §3.1).
 * Calls ring into ring groups and are answered or reach a mailbox, people make calls, presence
 * changes, a voicemail arrives, the trunk becomes unreachable once (Mucki's scenario 5), and in
 * the background a scanner gets banned. It writes the tenant the way `core` does — live calls,
 * history rows with their routing trace, voicemails, presence — and emits the API's events
 * (§10.6). It pauses with the demo bar and while signed out.
 */
import { emit } from '#lib/api/events.svelte.js';
import { newId } from '#lib/api/ids.js';
import { ringGroupMembers } from '#lib/api/ops/areas/calls.js';
import { DID, MENU, NUM, RG, TRUNK, U } from '#lib/api/seed/ids.js';
import { store, touch } from '#lib/api/store.svelte.js';
import type {
  Call,
  CallLogLine,
  ForwardTarget,
  LiveCall,
  PresenceStatus,
  ScheduleScope
} from '#lib/api/types.js';
import { now as demoNow, nowDate as demoNowDate } from '#lib/clock.svelte.js';
import {
  scopeKey,
  scopeStatus
} from '#lib/components/schedule-scope/status.js';
import { onDemoReset } from '#lib/state/demo.js';
import { session } from '#lib/state/session.svelte.js';

const SECOND = 1000;
const MIN_GAP_S = 10;
const MAX_GAP_S = 25;
/** The trunk drops once, this long after the simulator starts. */
const TRUNK_FLAP_AFTER_S = 75;
/** An unreachable trunk recovers on its own after this long unless re-registered first. */
const TRUNK_RECOVER_AFTER_S = 300;

const CALLERS = [
  { number: '+49897788990', name: 'Bäckerei Huber GmbH' },
  { number: '+49816155520', name: 'Autohaus Maier KG' },
  { number: '+49893344556', name: 'Praxis Dr. Schuster' },
  { number: '+491715550177', name: 'Elif Kaya' },
  { number: '+49816155530', name: 'Bauer Elektrotechnik' },
  { number: '+4930555123', name: null },
  { number: '+491525550111', name: null }
] as const;

const OUTBOUND_USERS = [
  U.lea,
  U.felix,
  U.daniel,
  U.laura,
  U.katrin,
  U.mira,
  U.sophie
];
const PRESENCE_USERS = [U.sophie, U.daniel, U.laura, U.katrin, U.aylin, U.nina];

const pick = <T>(items: readonly T[]): T =>
  items[Math.floor(Math.random() * items.length)] as T;
const between = (low: number, high: number): number =>
  Math.floor(low + Math.random() * (high - low + 1));
const sip = (number: string): string => `sip:${number}@tel.brandt-partner.de`;
const now = (): string => demoNowDate().toISOString();

let timers: ReturnType<typeof setTimeout>[] = [];
let started = false;
let trunkFlapped = false;

function later(seconds: number, action: () => void): void {
  const timer = setTimeout(() => {
    timers = timers.filter(other => other !== timer);
    action();
  }, seconds * SECOND);
  timers.push(timer);
}

const running = (): boolean =>
  session.signedIn &&
  !session.simulatorPaused &&
  document.visibilityState === 'visible';

function extensionOf(userId: string): string {
  return store.db.users.find(user => user.id === userId)?.extension ?? '';
}

function isFree(userId: string): boolean {
  const user = store.db.users.find(candidate => candidate.id === userId);
  const status = store.db.presence[userId]?.status;
  return user !== undefined && !user.dnd && status === 'available';
}

function setPresence(
  userId: string,
  status: PresenceStatus,
  peer: string | null = null,
  ringGroupId: string | null = null
): void {
  const entry = { userId, status, since: now(), peer, ringGroupId };
  store.db.presence[userId] = entry;
  store.db.presenceLog.unshift(entry);
  emit({ type: 'presence', userId, status, peer, ringGroupId }, [userId]);
}

/** Whether any trunk can carry calls: an unreachable trunk takes no calls in or out. */
function trunkUp(): boolean {
  return store.db.trunks.some(
    trunk => trunk.deletedAt === null && trunk.status !== 'unreachable'
  );
}

function liveCall(callId: string): LiveCall | undefined {
  return store.db.liveCalls.find(call => call.callId === callId);
}

function endLive(callId: string): void {
  store.db.liveCalls = store.db.liveCalls.filter(
    call => call.callId !== callId
  );
}

function appendHistory(call: Call, audience: string[]): void {
  store.db.calls.unshift(call);
  emit({ type: 'history.appended', callId: call.id }, audience);
}

/** The company's numbers, as a caller reaches them: the scope whose schedule applies there. */
export type Entry =
  | { kind: 'menu'; did: string; number: string; menuId: string }
  | { kind: 'group'; did: string; number: string; ringGroupId: string }
  | { kind: 'user'; did: string; number: string; userId: string };

export const ENTRIES: { entry: Entry; weight: number }[] = [
  {
    entry: {
      kind: 'menu',
      did: DID.main,
      number: NUM.main,
      menuId: MENU.haupt
    },
    weight: 4
  },
  {
    entry: {
      kind: 'group',
      did: DID.hotline,
      number: NUM.hotline,
      ringGroupId: RG.support
    },
    weight: 3
  },
  {
    entry: {
      kind: 'user',
      did: DID.felix,
      number: `${NUM.blockBase}104`,
      userId: U.felix
    },
    weight: 2
  },
  {
    entry: {
      kind: 'user',
      did: DID.lea,
      number: `${NUM.blockBase}101`,
      userId: U.lea
    },
    weight: 1
  },
  {
    entry: {
      kind: 'user',
      did: DID.mira,
      number: `${NUM.blockBase}103`,
      userId: U.mira
    },
    weight: 1
  }
];

function pickEntry(): Entry {
  const total = ENTRIES.reduce((sum, item) => sum + item.weight, 0);
  let roll = Math.random() * total;
  for (const item of ENTRIES) {
    roll -= item.weight;
    if (roll < 0) {
      return item.entry;
    }
  }
  return ENTRIES[0]!.entry;
}

/** One inbound call on its way through routing: who called, what it dialled, its trace. */
type Inbound = {
  callId: string;
  startedAt: string;
  caller: string;
  did: string;
  number: string;
  ringGroupId: string | null;
  calleeUserId: string | null;
  log: CallLogLine[];
};

const scopeOf = (entry: Entry): ScheduleScope =>
  entry.kind === 'menu'
    ? { kind: 'menu', id: entry.menuId }
    : entry.kind === 'group'
      ? { kind: 'ringGroup', id: entry.ringGroupId }
      : { kind: 'user', id: entry.userId };

/** Writes the ended call to the history and tells the people it concerned. */
function finish(
  call: Inbound,
  fields: Pick<Call, 'status' | 'answeredAt' | 'answeredByUserId'>,
  audience: string[]
): void {
  endLive(call.callId);
  const endedAt = now();
  appendHistory(
    {
      id: call.callId,
      parentCallId: null,
      direction: 'inbound',
      fromUri: sip(call.caller),
      toUri: sip(call.number),
      didId: call.did,
      callerUserId: null,
      calleeUserId: call.calleeUserId,
      ringGroupId: call.ringGroupId,
      startedAt: call.startedAt,
      endedAt,
      log: call.log,
      sipTrace: [],
      qos: [],
      ...fields
    },
    audience
  );
  emit(
    {
      type: 'call.state',
      callId: call.callId,
      state: 'ended',
      peer: call.caller,
      ringGroupId: call.ringGroupId,
      userId: fields.answeredByUserId,
      legs: []
    },
    audience
  );
  touch();
}

/** Leaves a message in a mailbox and ends the call there. */
function mailbox(
  call: Inbound,
  box: { userId?: string; ringGroupId?: string },
  reason: string,
  audience: string[]
): void {
  const at = now();
  call.log.push({ at, event: 'mailbox', ...box, reason });
  call.log.push({ at, event: 'ended', by: 'caller', cause: 16 });
  const id = newId();
  store.db.voicemails.unshift({
    id,
    mailboxUserId: box.userId ?? null,
    mailboxRingGroupId: box.ringGroupId ?? null,
    caller: '+49897766554',
    filename: `${id}.wav`,
    durationS: 7,
    read: false,
    createdAt: at,
    callId: call.callId,
    clip: 'vm-short-lindner'
  });
  emit({
    type: 'voicemail.new',
    voicemailId: id,
    mailbox:
      box.userId !== undefined
        ? { kind: 'user', userId: box.userId }
        : { kind: 'ringGroup', ringGroupId: box.ringGroupId ?? '' }
  });
  finish(
    call,
    { status: 'voicemail', answeredAt: null, answeredByUserId: null },
    audience
  );
}

/** Puts the call live, ringing `ringing`, answered after a few seconds by `answerer` or given up. */
function ring(
  call: Inbound,
  ringing: string[],
  answerer: string | null,
  onNoAnswer: () => void
): void {
  const live: LiveCall = {
    callId: call.callId,
    direction: 'inbound',
    from: call.caller,
    to: call.number,
    state: 'ringing',
    startedAt: call.startedAt,
    ringGroupId: call.ringGroupId,
    userIds: ringing,
    legs: [
      {
        id: newId(),
        role: 'caller',
        state: 'up',
        trunkId: TRUNK.nordwind,
        target: call.caller
      },
      ...ringing.map(userId => ({
        id: newId(),
        role: 'callee' as const,
        state: 'ringing' as const,
        userId
      }))
    ]
  };
  store.db.liveCalls = store.db.liveCalls.filter(
    other => other.callId !== call.callId
  );
  store.db.liveCalls.push(live);
  emit(
    {
      type: 'call.state',
      callId: call.callId,
      state: 'ringing',
      peer: call.caller,
      ringGroupId: call.ringGroupId,
      userId: null,
      legs: live.legs
    },
    ringing
  );
  touch();
  later(between(4, 9), () => {
    const current = liveCall(call.callId);
    if (current === undefined) {
      return;
    }
    if (answerer === null) {
      onNoAnswer();
      return;
    }
    const answeredAt = now();
    current.state = 'up';
    current.userIds = [answerer];
    current.legs = current.legs
      .filter(leg => leg.role === 'caller' || leg.userId === answerer)
      .map(leg => ({ ...leg, state: 'up' as const }));
    call.log.push({
      at: answeredAt,
      event: 'answered',
      userId: answerer,
      ext: extensionOf(answerer)
    });
    setPresence(answerer, 'busy', call.caller, call.ringGroupId);
    emit(
      {
        type: 'call.state',
        callId: call.callId,
        state: 'up',
        peer: call.caller,
        ringGroupId: call.ringGroupId,
        userId: answerer,
        legs: current.legs
      },
      ringing
    );
    touch();
    later(between(25, 75), () => {
      if (liveCall(call.callId) === undefined) {
        return;
      }
      call.log.push({
        at: now(),
        event: 'ended',
        by: Math.random() < 0.5 ? 'caller' : 'callee',
        cause: 16
      });
      finish(
        call,
        { status: 'answered', answeredAt, answeredByUserId: answerer },
        [answerer]
      );
      setPresence(answerer, 'available');
      touch();
    });
  });
}

/**
 * Rings a ring group's free members; unanswered, its forwarding rule or mailbox takes the call.
 * Reached through a menu or a forward, the group's own out-of-office and opening hours apply
 * first (`ownSchedule`); the company's were checked where the call came in.
 */
function ringGroup(
  call: Inbound,
  ringGroupId: string,
  ownSchedule = false
): void {
  const group = store.db.ringGroups.find(
    candidate => candidate.id === ringGroupId && candidate.deletedAt === null
  );
  if (group === undefined) {
    return;
  }
  call.ringGroupId = ringGroupId;
  if (ownSchedule) {
    const scope: ScheduleScope = { kind: 'ringGroup', id: ringGroupId };
    const status = scopeStatus(store.db, scope, demoNow());
    const ooo = status.ooo !== null && !status.oooInherited ? status.ooo : null;
    const closed =
      status.open === false && !status.hoursInherited ? status.hours : null;
    if (ooo !== null || closed !== null) {
      const at = now();
      call.log.push({
        at,
        event: 'schedule',
        scope: scopeKey(scope),
        ooo: ooo?.id ?? null,
        hours: closed !== null ? 'closed' : 'open'
      });
      const target =
        ooo !== null ? ooo.target : (closed?.closedTarget as ForwardTarget);
      const condition = ooo !== null ? 'ooo' : 'closed';
      call.log.push({ at, event: 'forward', condition, target });
      deliver(call, target, condition, 2);
      return;
    }
  }
  const members = ringGroupMembers(store.db, group);
  const ringing = members.filter(isFree);
  const at = now();
  call.log.push({
    at,
    event: 'ringGroup',
    ringGroupId,
    strategy: group.strategy
  });
  for (const userId of members) {
    call.log.push(
      ringing.includes(userId)
        ? { at, event: 'rungDevice', userId, ext: extensionOf(userId) }
        : {
            at,
            event: 'skipped',
            userId,
            ext: extensionOf(userId),
            reason:
              store.db.users.find(user => user.id === userId)?.dnd === true
                ? 'dnd'
                : 'busy'
          }
    );
  }
  const answerer =
    ringing.length > 0 && Math.random() < 0.8 ? pick(ringing) : null;
  ring(call, ringing, answerer, () => {
    call.log.push({ at: now(), event: 'unanswered', ringGroupId });
    const rule = store.db.ringGroupForwarding[ringGroupId]?.find(
      candidate => candidate.condition === 'unanswered'
    );
    if (rule !== undefined) {
      call.log.push({
        at: now(),
        event: 'forward',
        condition: 'unanswered',
        target: rule.target
      });
      deliver(call, rule.target, 'unanswered', 1);
    } else if (group.mailboxEnabled) {
      mailbox(call, { ringGroupId }, 'unanswered', ringing);
    } else {
      call.log.push({ at: now(), event: 'ended', by: 'caller', cause: 16 });
      finish(
        call,
        { status: 'missed', answeredAt: null, answeredByUserId: null },
        ringing
      );
    }
  });
}

/** Rings a person directly; unanswered, their mailbox takes the call. */
function ringUser(call: Inbound, userId: string): void {
  const user = store.db.users.find(
    candidate => candidate.id === userId && candidate.deletedAt === null
  );
  if (user === undefined) {
    return;
  }
  call.calleeUserId = call.calleeUserId ?? userId;
  const free = isFree(userId);
  const at = now();
  call.log.push(
    free
      ? { at, event: 'rungDevice', userId, ext: extensionOf(userId) }
      : {
          at,
          event: 'skipped',
          userId,
          ext: extensionOf(userId),
          reason: user.dnd ? 'dnd' : 'busy'
        }
  );
  ring(
    call,
    free ? [userId] : [],
    free && Math.random() < 0.75 ? userId : null,
    () => {
      call.log.push({ at: now(), event: 'noAnswer', userId });
      if (user.mailboxEnabled) {
        mailbox(call, { userId }, 'noAnswer', [userId]);
      } else {
        call.log.push({ at: now(), event: 'ended', by: 'caller', cause: 16 });
        finish(
          call,
          { status: 'missed', answeredAt: null, answeredByUserId: null },
          [userId]
        );
      }
    }
  );
}

/** Sends the call where a forward target points (§9.4): a person, a group, a mailbox, an
 * announcement, a menu or an external number. */
function deliver(
  call: Inbound,
  target: ForwardTarget,
  reason: string,
  depth: number
): void {
  if (depth > 3) {
    return;
  }
  switch (target.kind) {
    case 'user':
      ringUser(call, target.userId);
      return;
    case 'ringGroup':
      ringGroup(call, target.ringGroupId, true);
      return;
    case 'mailboxUser':
      mailbox(call, { userId: target.userId }, reason, [target.userId]);
      return;
    case 'mailboxRingGroup':
      mailbox(call, { ringGroupId: target.ringGroupId }, reason, []);
      return;
    case 'menu':
      viaMenu(call, target.menuId, depth + 1);
      return;
    case 'announcement': {
      call.log.push({
        at: now(),
        event: 'announcement',
        audioId: target.audioId
      });
      ring(call, [], null, () => {
        call.log.push({ at: now(), event: 'ended', by: 'system', cause: 16 });
        finish(
          call,
          { status: 'missed', answeredAt: null, answeredByUserId: null },
          []
        );
      });
      return;
    }
    case 'external':
    case 'sip': {
      const answeredAt = now();
      call.log.push({
        at: answeredAt,
        event: 'answered',
        trunkId: target.kind === 'sip' ? target.trunkId : TRUNK.nordwind
      });
      later(between(20, 60), () => {
        call.log.push({ at: now(), event: 'ended', by: 'caller', cause: 16 });
        finish(
          call,
          { status: 'answered', answeredAt, answeredByUserId: null },
          []
        );
      });
    }
  }
}

/** A caller in the main menu picks a key at random among the menu's targets. */
function viaMenu(call: Inbound, menuId: string, depth: number): void {
  const menu = store.db.menus.find(
    candidate => candidate.id === menuId && candidate.deletedAt === null
  );
  if (menu === undefined) {
    return;
  }
  const choice = pick(menu.targets);
  if (choice === undefined) {
    deliver(call, menu.fallbackTarget, 'other', depth);
    return;
  }
  call.log.push({ at: now(), event: 'menu', menuId, digits: choice.digits });
  deliver(call, choice.target, 'other', depth);
}

/**
 * An inbound call to one of the company's numbers, routed as `core` does at the demo clock's
 * moment: an out-of-office rule in effect sends it to its target, closed opening hours to the
 * closed target, otherwise it reaches the menu, the group or the person.
 */
export function inboundCall(entry: Entry = pickEntry()): string {
  const caller = pick(CALLERS);
  const call: Inbound = {
    callId: newId(),
    startedAt: now(),
    caller: caller.number,
    did: entry.did,
    number: entry.number,
    ringGroupId: null,
    calleeUserId: entry.kind === 'user' ? entry.userId : null,
    log: []
  };
  const scope = scopeOf(entry);
  const status = scopeStatus(store.db, scope, demoNow());
  call.log.push({
    at: call.startedAt,
    event: 'entry',
    did: entry.number,
    didId: entry.did,
    caller: caller.number
  });
  call.log.push({
    at: call.startedAt,
    event: 'schedule',
    scope: scopeKey(scope),
    ooo: status.ooo?.id ?? null,
    hours: status.open === null ? null : status.open ? 'open' : 'closed'
  });
  if (status.ooo !== null) {
    call.log.push({
      at: call.startedAt,
      event: 'forward',
      condition: 'ooo',
      target: status.ooo.target
    });
    deliver(call, status.ooo.target, 'ooo', 0);
  } else if (status.open === false && status.hours !== null) {
    call.log.push({
      at: call.startedAt,
      event: 'forward',
      condition: 'closed',
      target: status.hours.closedTarget
    });
    deliver(call, status.hours.closedTarget, 'closed', 0);
  } else if (entry.kind === 'menu') {
    viaMenu(call, entry.menuId, 0);
  } else if (entry.kind === 'group') {
    ringGroup(call, entry.ringGroupId);
  } else {
    ringUser(call, entry.userId);
  }
  return call.callId;
}

/** A colleague calls out over the trunk. */
function outboundCall(): void {
  const userId = pick(OUTBOUND_USERS.filter(isFree));
  if (userId === undefined) {
    return;
  }
  const callee = pick(CALLERS);
  const callId = newId();
  const startedAt = now();
  const live: LiveCall = {
    callId,
    direction: 'outbound',
    from: extensionOf(userId),
    to: callee.number,
    state: 'up',
    startedAt,
    ringGroupId: null,
    userIds: [userId],
    legs: [
      { id: newId(), role: 'caller', state: 'up', userId },
      {
        id: newId(),
        role: 'callee',
        state: 'up',
        trunkId: TRUNK.nordwind,
        target: callee.number
      }
    ]
  };
  store.db.liveCalls.push(live);
  setPresence(userId, 'busy', callee.number);
  emit(
    {
      type: 'call.state',
      callId,
      state: 'up',
      peer: callee.number,
      ringGroupId: null,
      userId,
      legs: live.legs
    },
    [userId]
  );
  touch();
  later(between(20, 60), () => {
    if (liveCall(callId) === undefined) {
      return;
    }
    endLive(callId);
    const endedAt = now();
    appendHistory(
      {
        id: callId,
        parentCallId: null,
        direction: 'outbound',
        fromUri: sip(extensionOf(userId)),
        toUri: sip(callee.number),
        didId: null,
        callerUserId: userId,
        calleeUserId: null,
        ringGroupId: null,
        answeredByUserId: null,
        status: 'answered',
        startedAt,
        answeredAt: startedAt,
        endedAt,
        log: [
          { at: startedAt, event: 'outbound', userId, dialled: callee.number },
          {
            at: startedAt,
            event: 'attempt',
            trunkId: TRUNK.nordwind,
            host: 'sip.nordwind-telecom.example',
            callerId: NUM.main
          },
          { at: startedAt, event: 'answered', trunkId: TRUNK.nordwind },
          { at: endedAt, event: 'ended', by: 'caller', cause: 16 }
        ],
        sipTrace: [],
        qos: []
      },
      [userId]
    );
    setPresence(userId, 'available');
    emit(
      {
        type: 'call.state',
        callId,
        state: 'ended',
        peer: callee.number,
        ringGroupId: null,
        userId,
        legs: []
      },
      [userId]
    );
    touch();
  });
}

/** Two colleagues call each other: the extension network works whatever the trunks do. */
function internalCall(): void {
  const free = OUTBOUND_USERS.filter(isFree);
  const from = pick(free);
  const to = pick(free.filter(userId => userId !== from));
  if (from === undefined || to === undefined) {
    return;
  }
  const callId = newId();
  const startedAt = now();
  const live: LiveCall = {
    callId,
    direction: 'internal',
    from: extensionOf(from),
    to: extensionOf(to),
    state: 'up',
    startedAt,
    ringGroupId: null,
    userIds: [from, to],
    legs: [
      { id: newId(), role: 'caller', state: 'up', userId: from },
      { id: newId(), role: 'callee', state: 'up', userId: to }
    ]
  };
  store.db.liveCalls.push(live);
  setPresence(from, 'busy', extensionOf(to));
  setPresence(to, 'busy', extensionOf(from));
  emit(
    {
      type: 'call.state',
      callId,
      state: 'up',
      peer: extensionOf(to),
      ringGroupId: null,
      userId: from,
      legs: live.legs
    },
    [from, to]
  );
  touch();
  later(between(15, 50), () => {
    if (liveCall(callId) === undefined) {
      return;
    }
    endLive(callId);
    const endedAt = now();
    appendHistory(
      {
        id: callId,
        parentCallId: null,
        direction: 'internal',
        fromUri: sip(extensionOf(from)),
        toUri: sip(extensionOf(to)),
        didId: null,
        callerUserId: from,
        calleeUserId: to,
        ringGroupId: null,
        answeredByUserId: to,
        status: 'answered',
        startedAt,
        answeredAt: startedAt,
        endedAt,
        log: [
          {
            at: startedAt,
            event: 'internal',
            userId: from,
            dialled: extensionOf(to)
          },
          { at: startedAt, event: 'answered', userId: to },
          { at: endedAt, event: 'ended', by: 'caller', cause: 16 }
        ],
        sipTrace: [],
        qos: []
      },
      [from, to]
    );
    setPresence(from, 'available');
    setPresence(to, 'available');
    emit(
      {
        type: 'call.state',
        callId,
        state: 'ended',
        peer: extensionOf(to),
        ringGroupId: null,
        userId: from,
        legs: []
      },
      [from, to]
    );
    touch();
  });
}

/** Someone goes offline, comes back, or toggles do-not-disturb. */
function presenceChange(): void {
  const userId = pick(PRESENCE_USERS);
  const status = store.db.presence[userId]?.status;
  if (status === 'busy') {
    return;
  }
  setPresence(
    userId,
    status === 'available'
      ? pick(['offline', 'available'] as const)
      : 'available'
  );
  touch();
}

/** The calls a lost trunk carried end: in the history as interrupted, their people available. */
function dropTrunkCalls(trunkId: string): void {
  for (const call of store.db.liveCalls.filter(candidate =>
    candidate.legs.some(leg => leg.trunkId === trunkId)
  )) {
    endLive(call.callId);
    const endedAt = now();
    const external = call.direction === 'inbound' ? call.from : call.to;
    appendHistory(
      {
        id: call.callId,
        parentCallId: null,
        direction: call.direction,
        fromUri: sip(call.from),
        toUri: sip(call.to),
        didId: null,
        callerUserId:
          call.direction === 'outbound' ? (call.userIds[0] ?? null) : null,
        calleeUserId: null,
        ringGroupId: call.ringGroupId,
        answeredByUserId:
          call.direction === 'inbound' && call.state === 'up'
            ? (call.userIds[0] ?? null)
            : null,
        status: 'interrupted',
        startedAt: call.startedAt,
        answeredAt: call.state === 'up' ? call.startedAt : null,
        endedAt,
        log: [
          {
            at: call.startedAt,
            event: call.direction === 'inbound' ? 'entry' : 'outbound',
            caller: call.from,
            dialled: call.to
          },
          {
            at: endedAt,
            event: 'ended',
            by: 'system',
            reason: 'trunkUnreachable',
            trunkId
          }
        ],
        sipTrace: [],
        qos: []
      },
      call.userIds
    );
    for (const userId of call.userIds) {
      setPresence(userId, 'available');
    }
    emit(
      {
        type: 'call.state',
        callId: call.callId,
        state: 'ended',
        peer: external,
        ringGroupId: call.ringGroupId,
        userId: call.userIds[0] ?? null,
        legs: []
      },
      call.userIds
    );
  }
}

function trunkFlap(): void {
  const trunk = store.db.trunks.find(
    candidate => candidate.id === TRUNK.nordwind
  );
  if (
    trunk === undefined ||
    trunk.deletedAt !== null ||
    trunk.status !== 'registered'
  ) {
    return;
  }
  trunk.status = 'unreachable';
  trunk.statusChangedAt = now();
  emit({ type: 'trunk.status', trunkId: trunk.id, status: 'unreachable' });
  dropTrunkCalls(trunk.id);
  touch();
  later(TRUNK_RECOVER_AFTER_S, () => {
    const current = store.db.trunks.find(
      candidate => candidate.id === TRUNK.nordwind
    );
    if (current?.status === 'unreachable') {
      current.status = 'registered';
      current.statusChangedAt = now();
      current.registeredAt = now();
      emit({ type: 'trunk.status', trunkId: current.id, status: 'registered' });
      touch();
    }
  });
}

function sipBan(): void {
  const address = `${pick(['45.134.26', '185.243.5', '193.32.162', '80.94.95'])}.${between(2, 250)}`;
  if (
    store.db.sipBans.some(
      ban => ban.address === address && ban.liftedAt === null
    )
  ) {
    return;
  }
  const createdAt = now();
  const id = newId();
  store.db.sipBans.unshift({
    id,
    address,
    reason: 'authFailures',
    failures: between(10, 60),
    step: 1,
    createdAt,
    expiresAt: new Date(demoNow() + 86_400 * SECOND).toISOString(),
    liftedAt: null
  });
  emit({
    type: 'sipBan.added',
    banId: id,
    address,
    expiresAt: store.db.sipBans[0]?.expiresAt ?? null
  });
  touch();
}

/** Ends the seeded live calls after a while, as their talkers hang up. */
function endSeededCalls(): void {
  for (const call of store.db.liveCalls.filter(
    candidate => candidate.state === 'up'
  )) {
    later(between(30, 120), () => {
      const current = liveCall(call.callId);
      if (current === undefined) {
        return;
      }
      endLive(call.callId);
      const userId = current.userIds[0] ?? null;
      if (userId !== null) {
        setPresence(userId, 'available');
      }
      emit(
        {
          type: 'call.state',
          callId: call.callId,
          state: 'ended',
          peer: current.from,
          ringGroupId: null,
          userId,
          legs: []
        },
        current.userIds
      );
      touch();
    });
  }
}

function tick(): void {
  if (running()) {
    const roll = Math.random();
    if (roll < 0.45 && trunkUp()) {
      inboundCall();
    } else if (roll < 0.7) {
      if (trunkUp()) {
        outboundCall();
      } else {
        internalCall();
      }
    } else if (roll < 0.93) {
      presenceChange();
    } else {
      sipBan();
    }
  }
  later(between(MIN_GAP_S, MAX_GAP_S), tick);
}

export function startSimulator(): void {
  if (started) {
    return;
  }
  started = true;
  endSeededCalls();
  later(between(MIN_GAP_S, MAX_GAP_S), tick);
  later(TRUNK_FLAP_AFTER_S, function flapWhenRunning() {
    if (trunkFlapped) {
      return;
    }
    if (running()) {
      trunkFlapped = true;
      trunkFlap();
    } else {
      later(MIN_GAP_S, flapWhenRunning);
    }
  });
}

onDemoReset(() => {
  for (const timer of timers) {
    clearTimeout(timer);
  }
  timers = [];
  started = false;
  trunkFlapped = false;
  startSimulator();
});
