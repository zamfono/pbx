import { z } from 'zod';

import { HTTP_NOT_FOUND, QOS_ROLES, type Db } from '@zamfono/shared';

import { defineOperation, OpError, type Context } from '../types.js';
import {
  callOut,
  isOwnCall,
  ownCallWhere,
  toCallOut,
  type CallRow
} from './_shared.js';
import { redactLog } from './redactLog.js';

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

/** A call with the §7 diagnostics it recorded and the ids of its direct children. */
const callDetailOut = callOut.extend({
  log: z.string().nullable(),
  qos: z.array(callQosOut),
  childCallIds: z
    .array(z.string())
    .describe(
      'The ended calls whose parentCallId is this call, by start: its transfer, added and park legs; calls.list with parentCallId lists them.'
    )
});

/** The ended call `id`: a call still in progress is not history yet, so it answers 404 like an
 *  unknown id (§10.1 "Call aggregate"). */
async function endedCall(ctx: Context, id: string): Promise<CallRow> {
  const row = await ctx.db
    .selectFrom('calls')
    .selectAll()
    .where('id', '=', id)
    .where('endedAt', 'is not', null)
    .executeTakeFirst();
  if (!row) {
    throw new OpError(HTTP_NOT_FOUND, `call '${id}' not found`);
  }
  return row;
}

/** The `call_qos` rows of call `id` and its ended direct children, of which a `user` sees only
 * their own. */
async function qosAndChildren(
  db: Db,
  id: string,
  ownOf: string | null
): Promise<Pick<z.infer<typeof callDetailOut>, 'qos' | 'childCallIds'>> {
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
    .where('callId', '=', id)
    .orderBy('channelId')
    .execute();
  let children = db
    .selectFrom('calls')
    .select('id')
    .where('parentCallId', '=', id)
    .where('endedAt', 'is not', null);
  if (ownOf !== null) {
    children = children.where(eb => ownCallWhere(eb, ownOf));
  }
  const childRows = await children.orderBy('startedAt').orderBy('id').execute();
  return { qos, childCallIds: childRows.map(child => child.id) };
}

/**
 * The §7 diagnostics of call `row`, the `calls.log` JSON lines written at call end and the
 * `call_qos` rows of its legs, and its ended direct children, for a `user` only their own and
 * the log's SIP secrets redacted (`redactLog`).
 */
async function callDetail(
  ctx: Context,
  row: CallRow
): Promise<z.infer<typeof callDetailOut>> {
  const isUser = ctx.actor.role === 'user';
  return {
    ...toCallOut(row),
    log: isUser && row.log !== null ? redactLog(row.log) : row.log,
    ...(await qosAndChildren(ctx.db, row.id, isUser ? ctx.actor.id : null))
  };
}

/** The ended call `id` as `GET /calls/{id}` returns it to an admin, without its `log`, which is
 * no contract and can hold SIP header values: the call's part of the record an after-call
 * request sends (§10.6 "After-call requests"). `null` for a call that is not in the history. */
export async function callRecord(
  db: Db,
  id: string
): Promise<Omit<z.infer<typeof callDetailOut>, 'log'> | null> {
  const row = await db
    .selectFrom('calls')
    .selectAll()
    .where('id', '=', id)
    .where('endedAt', 'is not', null)
    .executeTakeFirst();
  return row === undefined
    ? null
    : { ...toCallOut(row), ...(await qosAndChildren(db, id, null)) };
}

/**
 * `GET /calls/{id}` (§7, §10.3 "Call history"): one call of the history with the diagnostics it
 * recorded — `calls.log` and its `call_qos` rows — and its direct children. A `user` reads only a
 * call they are the caller, the callee or the answering user of (§5.3), and of its children only
 * those.
 */
export const get = defineOperation({
  name: 'calls.get',
  description:
    'Reads one call of the history with its log, QoS summary (per leg jitter, loss, round trip and the packets received and sent) and the ids of its child calls.',
  input: z.object({ id: z.string() }).strict(),
  output: callDetailOut,
  problems: [HTTP_NOT_FOUND],
  minRole: 'user',
  scope: async (ctx, input) =>
    isOwnCall(ctx.actor.id, await endedCall(ctx, input.id)),
  readOnly: true,
  run: async (ctx, input) => callDetail(ctx, await endedCall(ctx, input.id))
});
