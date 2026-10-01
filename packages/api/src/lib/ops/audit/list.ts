import { z } from 'zod';

import { decodeCursor, encodeCursor } from '../../pagination.js';
import { instantInput, toStoredInstant } from '../instantInput.js';
import { defineOperation } from '../types.js';
import { toAuditEntryOut } from './_shared.js';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

const CHANNELS = ['rest', 'mcp', 'ui', 'undo', 'job'] as const;
const STATES = ['live', 'undone', 'all'] as const;

const inputSchema = z
  .object({
    entityKind: z
      .string()
      .optional()
      .describe(
        "Only entries about this kind of entity, such as 'user' or 'did'."
      ),
    entityId: z
      .string()
      .optional()
      .describe('Only entries about the entity with this id.'),
    actorUserId: z
      .string()
      .optional()
      .describe('Only entries made by this user.'),
    channel: z
      .enum(CHANNELS)
      .optional()
      .describe(
        'Only entries that arrived over this channel; undo marks an audit.undo, job a scheduled job.'
      ),
    clientId: z
      .string()
      .optional()
      .describe("Only entries made through this MCP client's OAuth client id."),
    operation: z
      .string()
      .optional()
      .describe("Only entries of this operation, such as 'users.create'."),
    from: instantInput
      .optional()
      .describe(
        'Only entries written at or after this ISO 8601 time, any offset (none: UTC).'
      ),
    to: instantInput
      .optional()
      .describe(
        'Only entries written at or before this ISO 8601 time, any offset (none: UTC).'
      ),
    state: z
      .enum(STATES)
      .optional()
      .describe(
        'live (the default) hides undone entries, undone shows only them, all shows both.'
      ),
    limit: z.number().int().positive().max(MAX_LIMIT).optional(),
    cursor: z.string().optional()
  })
  .strict();

/**
 * `GET /audit` (§5.7, §10.3): `audit_log` entries newest first, filterable by entity, actor,
 * channel, client, operation, time range and `state` (`live` hides undone entries, `undone`
 * shows only them, `all` shows both). Defaults to `live`, an admin's normal "what changed"
 * view; the full chronological sequence including undone entries is available with `state: 'all'`.
 */
export const list = defineOperation({
  name: 'audit.list',
  description:
    'Lists audit_log entries, filterable by entity, actor, channel, client, operation, time range and state.',
  input: inputSchema,
  minRole: 'admin',
  readOnly: true,
  run: async (ctx, input) => {
    const limit = input.limit ?? DEFAULT_LIMIT;
    const state = input.state ?? 'live';
    const cursor =
      input.cursor === undefined
        ? undefined
        : (decodeCursor(input.cursor) as { id: string }).id;
    const from =
      input.from === undefined ? undefined : toStoredInstant(input.from);
    const to = input.to === undefined ? undefined : toStoredInstant(input.to);
    const rows = await ctx.db
      .selectFrom('auditLog')
      .selectAll()
      .$if(input.entityKind !== undefined, qb =>
        qb.where('entityKind', '=', input.entityKind ?? '')
      )
      .$if(input.entityId !== undefined, qb =>
        qb.where('entityId', '=', input.entityId ?? '')
      )
      .$if(input.actorUserId !== undefined, qb =>
        qb.where('actorUserId', '=', input.actorUserId ?? '')
      )
      .$if(input.channel !== undefined, qb =>
        qb.where('channel', '=', input.channel ?? 'rest')
      )
      .$if(input.clientId !== undefined, qb =>
        qb.where('clientId', '=', input.clientId ?? '')
      )
      .$if(input.operation !== undefined, qb =>
        qb.where('operation', '=', input.operation ?? '')
      )
      .$if(from !== undefined, qb => qb.where('createdAt', '>=', from ?? ''))
      .$if(to !== undefined, qb => qb.where('createdAt', '<=', to ?? ''))
      .$if(state === 'live', qb => qb.where('undoneAt', 'is', null))
      .$if(state === 'undone', qb => qb.where('undoneAt', 'is not', null))
      .$if(cursor !== undefined, qb => qb.where('id', '<', cursor ?? ''))
      .orderBy('id', 'desc')
      .limit(limit + 1)
      .execute();
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return {
      items: page.map(toAuditEntryOut),
      nextCursor:
        rows.length > limit && last ? encodeCursor({ id: last.id }) : null
    };
  }
});
