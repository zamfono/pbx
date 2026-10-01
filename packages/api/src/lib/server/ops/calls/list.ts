import { z } from 'zod';

import type { LiveCall } from '@zamfono/shared';

import { decodeCursor, encodeCursor } from '$lib/server/pagination.js';

import { instantInput, tenantInstantReader } from '../instantInput.js';
import { defineOperation, OpError } from '../types.js';
import { getCoreClient, toCallOut } from './_shared.js';

const STATUS_FORBIDDEN = 403;
const DEFAULT_LIMIT = 50;

const DIRECTIONS = ['inbound', 'outbound', 'internal'] as const;
const STATUSES = [
  'answered',
  'missed',
  'busy',
  'failed',
  'voicemail',
  'blocked',
  'interrupted'
] as const;

const inputSchema = z
  .object({
    direction: z
      .enum(DIRECTIONS)
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
      .enum(STATUSES)
      .optional()
      .describe(
        "History only: the call's outcome; blocked means released at entry by the blocklist or anonymous-call rejection."
      ),
    live: z
      .boolean()
      .optional()
      .describe(
        'true returns the calls in progress now, unpaginated, each with userIds, the users it concerns now, instead of the history of ended calls.'
      ),
    limit: z.number().int().positive().optional(),
    cursor: z.string().optional()
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
 * currently has in progress instead of history rows, unpaginated. History holds only ended calls:
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
    if (
      ctx.actor.role === 'user' &&
      input.userId !== undefined &&
      input.userId !== ctx.actor.id
    ) {
      throw new OpError(
        STATUS_FORBIDDEN,
        'calls: may list only your own calls'
      );
    }
    const ownUserId = ctx.actor.role === 'user' ? ctx.actor.id : null;
    if (input.live === true) {
      const state = await getCoreClient().state();
      return {
        items: state.calls
          .filter(call => matchesLive(call, input, ownUserId))
          .map(listedLiveCall),
        nextCursor: null
      };
    }
    const limit = input.limit ?? DEFAULT_LIMIT;
    const cursor =
      input.cursor === undefined
        ? undefined
        : (decodeCursor(input.cursor) as { id: string }).id;
    const toStoredInstant = await tenantInstantReader(ctx.db);
    const from =
      input.from === undefined ? undefined : toStoredInstant(input.from);
    const to = input.to === undefined ? undefined : toStoredInstant(input.to);
    const rows = await ctx.db
      .selectFrom('calls')
      .selectAll()
      .where('endedAt', 'is not', null)
      .$if(input.direction !== undefined, qb =>
        qb.where('direction', '=', input.direction ?? 'inbound')
      )
      .$if(input.status !== undefined, qb =>
        qb.where('status', '=', input.status ?? 'answered')
      )
      .$if(input.ringGroupId !== undefined, qb =>
        qb.where('ringGroupId', '=', input.ringGroupId ?? '')
      )
      .$if(from !== undefined, qb => qb.where('startedAt', '>=', from ?? ''))
      .$if(to !== undefined, qb => qb.where('startedAt', '<=', to ?? ''))
      .$if(input.userId !== undefined, qb =>
        qb.where(eb =>
          eb.or([
            eb('callerUserId', '=', input.userId ?? ''),
            eb('calleeUserId', '=', input.userId ?? ''),
            eb('answeredByUserId', '=', input.userId ?? '')
          ])
        )
      )
      .$if(ownUserId !== null, qb =>
        qb.where(eb =>
          eb.or([
            eb('callerUserId', '=', ownUserId ?? ''),
            eb('calleeUserId', '=', ownUserId ?? ''),
            eb('answeredByUserId', '=', ownUserId ?? '')
          ])
        )
      )
      .$if(cursor !== undefined, qb => qb.where('id', '<', cursor ?? ''))
      .orderBy('id', 'desc')
      .limit(limit + 1)
      .execute();
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return {
      items: page.map(toCallOut),
      nextCursor:
        rows.length > limit && last ? encodeCursor({ id: last.id }) : null
    };
  }
});
