import { z } from 'zod';

import { HTTP_NOT_FOUND, QOS_ROLES } from '@zamfono/shared';

import { defineOperation, OpError, type Context } from '../types.js';
import {
  callOut,
  isOwnCall,
  ownCallWhere,
  toCallOut,
  type CallRow
} from './_shared.js';

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

/**
 * The §7 diagnostics of call `row`, the `calls.log` JSON lines written at call end and the
 * `call_qos` rows of its legs, and its ended direct children, for a `user` only their own.
 */
async function callDetail(
  ctx: Context,
  row: CallRow
): Promise<z.infer<typeof callDetailOut>> {
  const qos = await ctx.db
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
  let children = ctx.db
    .selectFrom('calls')
    .select('id')
    .where('parentCallId', '=', row.id)
    .where('endedAt', 'is not', null);
  if (ctx.actor.role === 'user') {
    const userId = ctx.actor.id;
    children = children.where(eb => ownCallWhere(eb, userId));
  }
  const childRows = await children.orderBy('startedAt').orderBy('id').execute();
  return {
    ...toCallOut(row),
    log: row.log,
    qos,
    childCallIds: childRows.map(child => child.id)
  };
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
