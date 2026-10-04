import { z } from 'zod';

import { CALL_DIRECTIONS, CALL_STATUSES, type LiveCall } from '@zamfono/shared';

import { getCoreClient } from '#lib/server/coreClient.js';
import {
  decodeIdCursor,
  decodeOffsetCursor,
  keysetPage,
  offsetPage,
  pageInput
} from '#lib/server/pagination.js';

import { assertSelfOrAdmin } from '../gates.js';
import { instantInput, tenantInstantReader } from '../instantInput.js';
import { defineOperation } from '../types.js';
import { ownCallWhere, toCallOut } from './_shared.js';

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
        "History only: calls started at or before this ISO 8601 time, any offset (none: the tenant's time zone); a time, not a number."
      ),
    userId: z
      .string()
      .optional()
      .describe('Only calls this user placed, was called on or answered.'),
    ringGroupId: z
      .string()
      .optional()
      .describe('Only calls that rang this ring group.'),
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
        'true returns the calls in progress now, each with userIds, the users it concerns now, instead of the history of ended calls.'
      ),
    ...pageInput.shape
  })
  .strict();

type Input = z.infer<typeof inputSchema>;

/** A live call as `calls.list` answers it: `connectedUserIds` is `api`'s own to check. */
function listedLiveCall(call: LiveCall): Omit<LiveCall, 'connectedUserIds'> {
  const {
    callId,
    direction,
    from,
    to,
    state,
    startedAt,
    ringGroupId,
    userIds
  } = call;
  return {
    callId,
    direction,
    from,
    to,
    state,
    startedAt,
    ringGroupId,
    userIds
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
  minRole: 'user',
  readOnly: true,
  run: async (ctx, input) => {
    if (input.userId !== undefined) {
      assertSelfOrAdmin(
        ctx.actor,
        input.userId,
        'calls: may list only your own calls'
      );
    }
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
    const toStoredInstant = await tenantInstantReader(ctx.db);
    const from =
      input.from === undefined ? undefined : toStoredInstant(input.from);
    const to = input.to === undefined ? undefined : toStoredInstant(input.to);
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
    if (from !== undefined) {
      query = query.where('startedAt', '>=', from);
    }
    if (to !== undefined) {
      query = query.where('startedAt', '<=', to);
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
