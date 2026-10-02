import type { Selectable, Transaction } from 'kysely';

import type { DB } from '@zamfono/shared';

import {
  createCallControlClient,
  type CallControlClient
} from '#lib/server/callControlClient.js';
import {
  coreRefusal,
  createCoreClient,
  type CoreClient
} from '#lib/server/coreClient.js';

import { OpError, type Context } from '../types.js';

const STATUS_FORBIDDEN = 403;

/** A `calls` row as Kysely's `CamelCasePlugin` maps it (§11.2). */
export type CallRow = Selectable<DB['calls']>;

export type CallDirection = 'inbound' | 'outbound' | 'internal';
export type CallStatus =
  | 'answered'
  | 'missed'
  | 'busy'
  | 'failed'
  | 'voicemail'
  | 'blocked'
  | 'interrupted';

export type CallOut = {
  id: string;
  parentCallId: string | null;
  direction: CallDirection;
  fromUri: string;
  toUri: string;
  didId: string | null;
  callerUserId: string | null;
  calleeUserId: string | null;
  ringGroupId: string | null;
  answeredByUserId: string | null;
  status: CallStatus;
  startedAt: string;
  answeredAt: string | null;
  endedAt: string | null;
};

/** One `call_qos` row, the per-leg RTCP summary of a call at diagnostics level `qos` (§7, §11.2).
 * `rxPackets` and `txPackets` are the packets the leg's RTP instance received from the peer and
 * sent to it: 0 received on an answered leg means no audio arrived from that side. */
export type CallQosOut = {
  channelId: string;
  role: string;
  jitterMs: number | null;
  lossPct: number | null;
  rttMs: number | null;
  rxPackets: number | null;
  txPackets: number | null;
};

/** A call with the §7 diagnostics it recorded: its `calls.log` and its per-leg `call_qos` rows. */
export type CallDetailOut = CallOut & {
  log: string | null;
  qos: CallQosOut[];
};

/** A `calls` row's list wire shape; `calls.get` carries the diagnostics of one call on top. */
export function toCallOut(row: CallRow): CallOut {
  return {
    id: row.id,
    parentCallId: row.parentCallId,
    direction: row.direction as CallDirection,
    fromUri: row.fromUri,
    toUri: row.toUri,
    didId: row.didId,
    callerUserId: row.callerUserId,
    calleeUserId: row.calleeUserId,
    ringGroupId: row.ringGroupId,
    answeredByUserId: row.answeredByUserId,
    status: row.status as CallStatus,
    startedAt: row.startedAt,
    answeredAt: row.answeredAt,
    endedAt: row.endedAt
  };
}

/**
 * A call with its §7 diagnostics: the `calls.log` JSON lines written at call end and the
 * `call_qos` rows of the legs, queryable alongside the call history.
 */
export async function toCallDetailOut(
  db: Transaction<DB>,
  row: CallRow
): Promise<CallDetailOut> {
  const qos = await db
    .selectFrom('callQos')
    .select([
      'channelId',
      'role',
      'jitterMs',
      'lossPct',
      'rttMs',
      'rxPackets',
      'txPackets'
    ])
    .where('callId', '=', row.id)
    .orderBy('channelId')
    .execute();
  return { ...toCallOut(row), log: row.log, qos };
}

/** Whether `actor` is the caller, the callee or the answering user of `row` (§5.3, §10.3). */
export function isOwnCall(actorId: string, row: CallRow): boolean {
  return (
    row.callerUserId === actorId ||
    row.calleeUserId === actorId ||
    row.answeredByUserId === actorId
  );
}

let coreClient: CoreClient = createCoreClient();

/** Test-only: replaces the `CoreClient` the live-call operations proxy through. */
export function setCoreClientForTest(client: CoreClient): void {
  coreClient = client;
}

export function getCoreClient(): CoreClient {
  return coreClient;
}

let callControlClient: CallControlClient = createCallControlClient();

/** Test-only: replaces the `CallControlClient` the call-control operations proxy through. */
export function setCallControlClientForTest(client: CallControlClient): void {
  callControlClient = client;
}

export function getCallControlClient(): CallControlClient {
  return callControlClient;
}

/**
 * Throws 403 for a `user` actor naming another user in `userId` (§10.3 "Click-to-dial"): a
 * `user` may act only for themselves, an admin for any user. Returns the effective user id.
 */
export function resolveActingUserId(
  ctx: Context,
  userId: string | undefined
): string {
  const effective = userId ?? ctx.actor.id;
  if (ctx.actor.role === 'user' && effective !== ctx.actor.id) {
    throw new OpError(STATUS_FORBIDDEN, 'calls: may act only for yourself');
  }
  return effective;
}

/**
 * Throws 403 unless `ctx.actor` may end or transfer the live call `callId` (§10.3 "Live calls"):
 * an admin/owner any call, a `user` one they placed or have a leg up in, not one they only see
 * (as its callee, or rung for it). A call absent from `core`'s live state answers 403 too, since a
 * `user` has no standing over a call that either already ended or never existed.
 */
export async function assertOwnLiveCall(
  ctx: Context,
  callId: string
): Promise<void> {
  if (ctx.actor.role !== 'user') {
    return;
  }
  const state = await coreClient.state();
  const call = state.calls.find(candidate => candidate.callId === callId);
  if (!call?.connectedUserIds.includes(ctx.actor.id)) {
    throw new OpError(
      STATUS_FORBIDDEN,
      'calls: may act only on your own live call'
    );
  }
}

/**
 * Runs a live-call action through `core`, turning its refusal into the matching problem (§10.3):
 * a call `core` holds no live state for is a 404, one it cannot act on in its current state a 409,
 * a target it cannot act on a 422, each with `core`'s reason as `detail` (`notFound`,
 * `notBridged`, `notRinging`, `noRegisteredDevice`, `noFreeSlot`, `noMailbox`, `held`,
 * `notHeld`, `consulting`, `notConsultation`, `notAnswered`, `invalidTarget`), as
 * `calls.originate` answers its own `noRegisteredDevice` (§10.2). Resolves with what the action
 * answered.
 */
export async function proxyCallAction<T>(action: () => Promise<T>): Promise<T> {
  try {
    return await action();
  } catch (error) {
    const refusal = coreRefusal(error);
    if (refusal === null) {
      throw error;
    }
    throw new OpError(refusal.status, refusal.title, refusal.detail);
  }
}
