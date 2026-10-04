import {
  decodeOffsetCursor,
  offsetPage,
  pageInput,
  pageOutput
} from '#lib/server/pagination.js';

import { defineOperation } from '../types.js';
import { loadRouteChildren, routeToWire, routeWire } from './_shared.js';

/** `GET /outboundRoutes` (§10.3): live routes in evaluation order (§9.4), offset-cursor paginated
 *  like every list endpoint (§10.3 "Conventions"). */
export const list = defineOperation({
  name: 'outboundRoutes.list',
  description:
    'Lists outbound routes in evaluation order, each with its callers and numbers.',
  input: pageInput.strict(),
  output: pageOutput(routeWire),
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
