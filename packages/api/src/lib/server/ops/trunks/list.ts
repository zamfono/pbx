import { z } from 'zod';

import {
  decodeOffsetCursor,
  offsetPage,
  pageInput
} from '#lib/server/pagination.js';

import { defineOperation } from '../types.js';
import { mapTrunkRow, type TrunkHostRow, type TrunkWire } from './_shared.js';
import { getTrunkStatuses, UNKNOWN_STATUS } from './_status.js';

const inputSchema = pageInput.strict();
type Input = z.infer<typeof inputSchema>;
type Output = { items: TrunkWire[]; nextCursor: string | null };

/** Groups `hosts` by `trunkId`, so each trunk's own hosts are looked up once per trunk. */
function groupHostsByTrunk(hosts: TrunkHostRow[]): Map<string, TrunkHostRow[]> {
  const byTrunk = new Map<string, TrunkHostRow[]>();
  for (const host of hosts) {
    const group = byTrunk.get(host.trunkId) ?? [];
    group.push(host);
    byTrunk.set(host.trunkId, group);
  }
  return byTrunk;
}

/** `GET /trunks` (§10.3): live trunks in trunk order (§9.4), offset-cursor paginated like every
 *  list endpoint (§10.3 "Conventions"). */
export const list = defineOperation<Input, Output>({
  name: 'trunks.list',
  description:
    'Lists SIP trunks in trunk order, with their live status merged in.',
  input: inputSchema,
  minRole: 'admin',
  readOnly: true,
  run: async (ctx, input) => {
    const offset = decodeOffsetCursor(input.cursor);
    const { limit } = input;
    const pageRows = await ctx.db
      .selectFrom('trunks')
      .selectAll()
      .where('deletedAt', 'is', null)
      .orderBy('priority')
      .offset(offset)
      .limit(limit + 1)
      .execute();
    const { page: rows, nextCursor } = offsetPage(pageRows, offset, limit);
    const trunkIds = rows.map(row => row.id);
    const hosts =
      trunkIds.length === 0
        ? []
        : await ctx.db
            .selectFrom('trunkHosts')
            .selectAll()
            .where('trunkId', 'in', trunkIds)
            .execute();
    const hostsByTrunk = groupHostsByTrunk(hosts);
    const statuses = await getTrunkStatuses(trunkIds);
    return {
      items: rows.map(row =>
        mapTrunkRow(
          row,
          hostsByTrunk.get(row.id) ?? [],
          statuses[row.id] ?? UNKNOWN_STATUS
        )
      ),
      nextCursor
    };
  }
});
