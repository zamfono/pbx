import { z } from 'zod';

import {
  CALL_DIRECTIONS,
  CALL_STATUSES,
  HTTP_SERVICE_UNAVAILABLE,
  type LiveCall
} from '@zamfono/shared';

import { getCoreClient } from '#lib/server/coreClient.js';
import {
  decodeIdCursor,
  decodeOffsetCursor,
  keysetPage,
  offsetPage,
  pageInput,
  pageOutput
} from '#lib/server/pagination.js';

import { ownActingUser } from '../gates.js';
import { instantInput, tenantInstantReader } from '../instantInput.js';
import { defineOperation } from '../types.js';
import { callOut, liveLegOut, ownCallWhere, toCallOut } from './_shared.js';

const inputSchema = z
  .object({
    direction: z
      .enum(CALL_DIRECTIONS)
      .optional()
      .describe('Only calls in this direction.'),
    from: instantInput
      .optional()
      .describe(
        "History only: calls started at or after this ISO 8601 time, any offset (none: the tenant's time zone); a time, not a number."
      ),
    to: instantInput
      .optional()
      .describe(
        "History only: calls started before this ISO 8601 time, any offset (none: the tenant's time zone), or before the end of this date; a time, not a number."
      ),
    userId: z
      .string()
      .optional()
      .describe('Only calls this user placed, was called on or answered.'),
    ringGroupId: z
      .string()
      .optional()
      .describe('Only calls that rang this ring group.'),
    parentCallId: z
      .string()
      .optional()
      .describe(
        'History only: the calls whose parentCallId is this call, its transfer, added and park legs.'
      ),
    status: z
      .enum(CALL_STATUSES)
      .optional()
      .describe(
        "History only: the call's outcome; blocked means released at entry by the blocklist or anonymous-call rejection."
      ),
    live: z
      .boolean()
      .optional()
      .describe(
        'true returns the calls in progress now, each with userIds, the users it concerns now, and legs, the parties in it, instead of the history of ended calls.'
      ),
    ...pageInput.shape
  })
  .strict();

type Input = z.infer<typeof inputSchema>;

/** A live call as `calls.list` answers it: `connectedUserIds` is `api`'s own to check. */
const liveCallOut = z.object({
  callId: z.string(),
  direction: z.enum(CALL_DIRECTIONS),
  from: z.string(),
  to: z.string(),
  state: z.enum(['ringing', 'up']),
  startedAt: z.string(),
  ringGroupId: z.string().nullable(),
  userIds: z
    .array(z.string())
    .describe(
      'The users the call concerns now: caller, callee, answerer and every user it rings.'
    ),
  legs: z
    .array(liveLegOut)
    .describe(
      'The parties in the call now, each with the id the call actions take as legId.'
    )
});

function listedLiveCall(call: LiveCall): z.infer<typeof liveCallOut> {
  const {
    callId,
    direction,
    from,
    to,
    state,
    startedAt,
    ringGroupId,
    userIds,
    legs
  } = call;
  return {
    callId,
    direction,
    from,
    to,
    state,
    startedAt,
    ringGroupId,
    userIds,
    legs
  };
}

/** Whether live call `call` matches `input`'s filters and, for a `user` actor, `ownUserId`. */
function matchesLive(
  call: LiveCall,
  input: Input,
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

/**
 * `GET /calls` (§10.2 "Call history", "Live calls", §5.3): a `user` sees only calls where they
 * are the caller, the callee or the answering user, and of the calls in progress also those a leg
 * of theirs rings or is up in (§10.3 "Live calls"); `live: true` returns the calls `core`
 * currently has in progress instead of history rows. History holds only ended calls:
 * a call in progress already has its row (core's placeholder, so recordings can reference it), but
 * that row is not a durable outcome until the call ends (§10.1 "Call aggregate").
 */
export const list = defineOperation({
  name: 'calls.list',
  description: 'Lists call history, or the calls currently in progress.',
  input: inputSchema,
  output: pageOutput(z.union([callOut, liveCallOut])),
  // `live=true` reads `core`, which may fail or not answer (`coreHttp.ts`).
  problems: [HTTP_SERVICE_UNAVAILABLE],
  minRole: 'user',
  scope: ownActingUser,
  readOnly: true,
  run: async (ctx, input) => {
    const ownUserId = ctx.actor.role === 'user' ? ctx.actor.id : null;
    const { limit } = input;
    if (input.live === true) {
      const offset = decodeOffsetCursor(ctx.operation, input.cursor);
      const state = await getCoreClient().state();
      const matching = state.calls.filter(call =>
        matchesLive(call, input, ownUserId)
      );
      const { page, nextCursor } = offsetPage(
        ctx.operation,
        matching.slice(offset, offset + limit + 1),
        offset,
        limit
      );
      return { items: page.map(listedLiveCall), nextCursor };
    }
    const cursor =
      input.cursor === undefined
        ? undefined
        : decodeIdCursor(ctx.operation, input.cursor);
    const instants = await tenantInstantReader(ctx.db);
    const from =
      input.from === undefined ? undefined : instants.start(input.from);
    const to = input.to === undefined ? undefined : instants.end(input.to);
    let query = ctx.db
      .selectFrom('calls')
      .selectAll()
      .where('endedAt', 'is not', null);
    if (input.direction !== undefined) {
      query = query.where('direction', '=', input.direction);
    }
    if (input.status !== undefined) {
      query = query.where('status', '=', input.status);
    }
    if (input.ringGroupId !== undefined) {
      query = query.where('ringGroupId', '=', input.ringGroupId);
    }
    if (input.parentCallId !== undefined) {
      query = query.where('parentCallId', '=', input.parentCallId);
    }
    if (from !== undefined) {
      query = query.where('startedAt', '>=', from);
    }
    if (to !== undefined) {
      query = query.where('startedAt', '<', to);
    }
    const { userId } = input;
    if (userId !== undefined) {
      query = query.where(eb => ownCallWhere(eb, userId));
    }
    if (ownUserId !== null) {
      query = query.where(eb => ownCallWhere(eb, ownUserId));
    }
    if (cursor !== undefined) {
      query = query.where('id', '<', cursor);
    }
    const rows = await query
      .orderBy('id', 'desc')
      .limit(limit + 1)
      .execute();
    const { page, nextCursor } = keysetPage(ctx.operation, rows, limit);
    return {
      items: page.map(toCallOut),
      nextCursor
    };
  }
});
