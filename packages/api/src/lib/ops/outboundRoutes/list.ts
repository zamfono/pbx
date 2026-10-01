import { z } from 'zod';

import { decodeCursor, encodeCursor } from '#lib/pagination.js';

import { defineOperation } from '../types.js';
import { loadRouteChildren, routeToWire, type RouteWire } from './_shared.js';

const DEFAULT_LIMIT = 50;

const inputSchema = z
  .object({
    limit: z.number().int().positive().optional(),
    cursor: z.string().optional()
  })
  .strict();
type Input = z.infer<typeof inputSchema>;
type Output = { items: RouteWire[]; nextCursor: string | null };

/** `GET /outboundRoutes` (§10.3): live routes in evaluation order (§9.4), offset-cursor paginated
 *  like every list endpoint (§10.3 "Conventions"). */
export const list = defineOperation<Input, Output>({
  name: 'outboundRoutes.list',
  description:
    'Lists outbound routes in evaluation order, each with its callers and numbers.',
  input: inputSchema,
  minRole: 'admin',
  readOnly: true,
  run: async (ctx, input) => {
    const offset =
      input.cursor === undefined
        ? 0
        : (decodeCursor(input.cursor) as { offset: number }).offset;
    const limit = input.limit ?? DEFAULT_LIMIT;
    const pageRows = await ctx.db
      .selectFrom('outboundRoutes')
      .selectAll()
      .where('deletedAt', 'is', null)
      .orderBy('priority')
      .offset(offset)
      .limit(limit + 1)
      .execute();
    const rows = pageRows.slice(0, limit);
    const children = await loadRouteChildren(
      ctx.db,
      rows.map(row => row.id)
    );
    return {
      items: rows.map(row => routeToWire(row, children)),
      nextCursor:
        pageRows.length > limit
          ? encodeCursor({ offset: offset + limit })
          : null
    };
  }
});
