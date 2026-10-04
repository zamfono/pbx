import { z } from 'zod';

import {
  decodeIdCursor,
  keysetPage,
  pageInput
} from '#lib/server/pagination.js';

import { instantInput, tenantInstantReader } from '../instantInput.js';
import { defineOperation } from '../types.js';
import { toAuditEntryOut } from './_shared.js';

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
        "Only entries written at or after this ISO 8601 time, any offset (none: the tenant's time zone)."
      ),
    to: instantInput
      .optional()
      .describe(
        "Only entries written at or before this ISO 8601 time, any offset (none: the tenant's time zone)."
      ),
    state: z
      .enum(STATES)
      .optional()
      .describe(
        'live (the default) hides undone entries, undone shows only them, all shows both.'
      ),
    ...pageInput.shape
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
    const { limit } = input;
    const state = input.state ?? 'live';
    const cursor =
      input.cursor === undefined
        ? undefined
        : decodeIdCursor(ctx.operation, input.cursor);
    const toStoredInstant = await tenantInstantReader(ctx.db);
    const from =
      input.from === undefined ? undefined : toStoredInstant(input.from);
    const to = input.to === undefined ? undefined : toStoredInstant(input.to);
    let query = ctx.db.selectFrom('auditLog').selectAll();
    if (input.entityKind !== undefined) {
      query = query.where('entityKind', '=', input.entityKind);
    }
    if (input.entityId !== undefined) {
      query = query.where('entityId', '=', input.entityId);
    }
    if (input.actorUserId !== undefined) {
      query = query.where('actorUserId', '=', input.actorUserId);
    }
    if (input.channel !== undefined) {
      query = query.where('channel', '=', input.channel);
    }
    if (input.clientId !== undefined) {
      query = query.where('clientId', '=', input.clientId);
    }
    if (input.operation !== undefined) {
      query = query.where('operation', '=', input.operation);
    }
    if (from !== undefined) {
      query = query.where('createdAt', '>=', from);
    }
    if (to !== undefined) {
      query = query.where('createdAt', '<=', to);
    }
    if (state === 'live') {
      query = query.where('undoneAt', 'is', null);
    }
    if (state === 'undone') {
      query = query.where('undoneAt', 'is not', null);
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
      items: page.map(toAuditEntryOut),
      nextCursor
    };
  }
});
