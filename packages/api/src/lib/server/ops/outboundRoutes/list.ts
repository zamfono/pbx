import { z } from 'zod';

import {
  decodeOffsetCursor,
  offsetPage,
  pageInput
} from '#lib/server/pagination.js';

import { defineOperation } from '../types.js';
import { loadRouteChildren, routeToWire, type RouteWire } from './_shared.js';

const inputSchema = pageInput.strict();
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
    const offset = decodeOffsetCursor(ctx.operation, input.cursor);
    const { limit } = input;
    const pageRows = await ctx.db
      .selectFrom('outboundRoutes')
      .selectAll()
      .where('deletedAt', 'is', null)
      .orderBy('priority')
      .offset(offset)
      .limit(limit + 1)
      .execute();
    const { page: rows, nextCursor } = offsetPage(
      ctx.operation,
      pageRows,
      offset,
      limit
    );
    const children = await loadRouteChildren(
      ctx.db,
      rows.map(row => row.id)
    );
    return {
      items: rows.map(row => routeToWire(row, children)),
      nextCursor
    };
  }
});
