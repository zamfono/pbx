import type { ExpressionBuilder, Selectable } from 'kysely';
import { z } from 'zod';

import {
  CALL_DIRECTIONS,
  CALL_STATUSES,
  HTTP_CONFLICT,
  HTTP_NOT_FOUND,
  HTTP_SERVICE_UNAVAILABLE,
  HTTP_UNPROCESSABLE_CONTENT,
  LIVE_LEG_ROLES,
  LIVE_LEG_STATES,
  QOS_ROLES,
  type DB,
  type Db
} from '@zamfono/shared';

import { getCoreClient } from '#lib/server/coreClient.js';

import { OpError, type Context } from '../types.js';

/** A `calls` row as Kysely's `CamelCasePlugin` maps it (§11.2). */
export type CallRow = Selectable<DB['calls']>;

/** The `id` input of an action on a live call (§10.3 "Live calls"). */
export const liveCallIdInput = z
  .string()
  // `core` names calls in its URL paths: an id of anything but this charset, or a dot segment
  // the URL normalises away, could only ever reach some other route.
  .regex(/^(?!\.{1,2}$)[A-Za-z0-9._-]+$/u)
  .describe("The live call's id, as calls.list with live=true lists it.");

/** The `legId` input of an action on a live call (§10.3 "Live calls"): `what` says what the
 * named leg does. */
export function legIdInput(what: string) {
  return z
    .string()
    .min(1)
    .optional()
    .describe(
      `The leg ${what}, by its id in the call's legs as calls.list with live=true lists them; left out, your own other party. Required when you are not in the call yourself.`
    );
}

/** One leg of a live call, as `calls.list` with `live=true` lists it (§10.3 "Live calls"). */
export const liveLegOut = z.object({
  id: z
    .string()
    .describe("The leg's id, which legId names in the call actions."),
  role: z.enum(LIVE_LEG_ROLES),
  state: z.enum(LIVE_LEG_STATES),
  userId: z.string().optional(),
  deviceId: z.string().optional(),
  trunkId: z.string().optional(),
  target: z
    .string()
    .optional()
    .describe('The number or SIP target a trunk leg dials.')
});

/** The `target` input of an action that dials from the caller's own phone: `verb` names whom. */
export function dialTargetInput(verb: string): z.ZodString {
  return z
    .string()
    .min(1)
    .describe(
      `Whom to ${verb}, dialled from you as your phone would: an extension, or an external number E.164 or national.`
    );
}

/** A call of the history, as `calls.list` lists it (§10.3 "Call history"). */
export const callOut = z.object({
  id: z.string(),
  parentCallId: z.string().nullable(),
  direction: z.enum(CALL_DIRECTIONS),
  fromUri: z.string(),
  toUri: z.string(),
  didId: z.string().nullable(),
  callerUserId: z.string().nullable(),
  calleeUserId: z.string().nullable(),
  ringGroupId: z.string().nullable(),
  answeredByUserId: z.string().nullable(),
  status: z.enum(CALL_STATUSES),
  startedAt: z.string(),
  answeredAt: z.string().nullable(),
  endedAt: z.string().nullable()
});
export type CallOut = z.infer<typeof callOut>;

/** One `call_qos` row, the per-leg RTCP summary of a call at diagnostics level `qos` (§7, §11.2).
 * `rxPackets` and `txPackets` are the packets the leg's RTP instance received from the peer and
 * sent to it: 0 received on an answered leg means no audio arrived from that side. */
const callQosOut = z.object({
  channelId: z.string(),
  role: z.enum(QOS_ROLES),
  jitterMs: z.number().nullable(),
  lossPct: z.number().nullable(),
  rttMs: z.number().nullable(),
  rxPackets: z.number().nullable(),
  txPackets: z.number().nullable()
});

/** A call with the §7 diagnostics it recorded: its `calls.log` and its per-leg `call_qos` rows. */
export const callDetailOut = callOut.extend({
  log: z.string().nullable(),
  qos: z.array(callQosOut)
});
export type CallDetailOut = z.infer<typeof callDetailOut>;

/** The `output` of an action on the live call `id`. */
export const callActionOutput = z.object({ id: z.string() });

/** The `output` of an action that dialled a new call into the live call `id`: its own `callId`. */
export const dialledCallOutput = callActionOutput.extend({
  callId: z.string()
});

/**
 * The problems a call action answers with through `core` (`coreHttp.ts`), besides the input's
 * 422 (§10.2 "Click-to-dial", §10.3): a call `core` holds no live state for is a 404, one it
 * cannot act on in its current state or a user without a registered device a 409, a target it
 * cannot act on a 422, each with `core`'s reason as `detail` (`notFound`, `notBridged`,
 * `notInCall`, `notRinging`, `noRegisteredDevice`, `noFreeSlot`, `noMailbox`, `held`, `notHeld`,
 * `consulting`, `notConsultation`, `notAnswered`, `invalidTarget`); any other failure of `core`,
 * not answering included, is a 503.
 */
export const CALL_ACTION_PROBLEMS = [
  HTTP_NOT_FOUND,
  HTTP_CONFLICT,
  HTTP_SERVICE_UNAVAILABLE
] as const;

/** A `calls` row's list wire shape; `calls.get` carries the diagnostics of one call on top. */
export function toCallOut(row: CallRow): CallOut {
  return {
    id: row.id,
    parentCallId: row.parentCallId,
    direction: row.direction,
    fromUri: row.fromUri,
    toUri: row.toUri,
    didId: row.didId,
    callerUserId: row.callerUserId,
    calleeUserId: row.calleeUserId,
    ringGroupId: row.ringGroupId,
    answeredByUserId: row.answeredByUserId,
    status: row.status,
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
  db: Db,
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

/** `calls` rows `userId` is the caller, the callee or the answering user of (§5.3, §10.3). */
export function ownCallWhere(
  eb: ExpressionBuilder<DB, 'calls'>,
  userId: string
) {
  return eb.or([
    eb('callerUserId', '=', userId),
    eb('calleeUserId', '=', userId),
    eb('answeredByUserId', '=', userId)
  ]);
}

/** Whether `actor` is the caller, the callee or the answering user of `row` (§5.3, §10.3). */
export function isOwnCall(actorId: string, row: CallRow): boolean {
  return (
    row.callerUserId === actorId ||
    row.calleeUserId === actorId ||
    row.answeredByUserId === actorId
  );
}

/**
 * Whether the live call `callId` is `ctx.actor`'s own to act on (§10.3 "Live calls"): one they
 * placed or have a leg up in, not one they only see (as its callee, or rung for it). A call absent
 * from `core`'s live state is not, since a `user` has no standing over a call that either already
 * ended or never existed.
 */
export async function isOwnLiveCall(
  ctx: Context,
  callId: string
): Promise<boolean> {
  const state = await getCoreClient().state();
  const call = state.calls.find(candidate => candidate.callId === callId);
  return call?.connectedUserIds.includes(ctx.actor.id) ?? false;
}

/** The `scope` of an action on the live call `id`: the caller's own live call alone. */
export function ownLiveCall(
  ctx: Context,
  input: { id: string }
): Promise<boolean> {
  return isOwnLiveCall(ctx, input.id);
}

/**
 * Refuses with 422 an action that takes the actor's own other party (no `legId`) from an actor
 * with no channel in the live call `id` (§10.3 "Live calls"): an admin acting on someone else's
 * call names the leg. A call `core` does not hold is left to `core`'s 404.
 */
export async function requireLegOrPresence(
  ctx: Context,
  input: { id: string; legId?: string | undefined }
): Promise<void> {
  if (input.legId !== undefined) {
    return;
  }
  const state = await getCoreClient().state();
  const call = state.calls.find(candidate => candidate.callId === input.id);
  if (call !== undefined && !call.connectedUserIds.includes(ctx.actor.id)) {
    throw new OpError(
      HTTP_UNPROCESSABLE_CONTENT,
      'calls: you are not in this call; name the leg with legId'
    );
  }
}
