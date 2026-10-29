import { pageInput, pageOutput, sqlPage } from '#lib/server/pagination.js';

import { defineOperation } from '../types.js';
import { loadRouteChildren, routeToWire, routeWire } from './_shared.js';

/** `GET /outboundRoutes` (§10.3): live routes in evaluation order (§9.4), paginated
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
    const {
      page: rows,
      nextPageToken,
      totalSize
    } = await sqlPage(
      ctx.operation,
      input,
      ctx.db
        .selectFrom('outboundRoutes')
        .selectAll()
        .where('deletedAt', 'is', null),
      [
        ['priority', 'asc'],
        ['id', 'asc']
      ]
    );
    const children = await loadRouteChildren(
      ctx.db,
      rows.map(row => row.id)
    );
    return {
      items: rows.map(row => routeToWire(row, children)),
      nextPageToken,
      totalSize
    };
  }
});
