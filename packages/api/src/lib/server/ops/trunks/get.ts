import { z } from 'zod';

import { HTTP_NOT_FOUND } from '@zamfono/shared';

import { defineOperation } from '../types.js';
import {
  liveTrunk,
  loadTrunkHosts,
  mapTrunkRow,
  trunkWire
} from './_shared.js';
import { getTrunkStatuses, UNKNOWN_STATUS } from './_status.js';

const inputSchema = z.object({ id: z.string().min(1) }).strict();
export const get = defineOperation({
  name: 'trunks.get',
  description: 'Reads one SIP trunk.',
  input: inputSchema,
  output: trunkWire,
  problems: [HTTP_NOT_FOUND],
  minRole: 'admin',
  readOnly: true,
  run: async (ctx, input) => {
    const row = await liveTrunk(ctx.db, input.id);
    const hosts = await loadTrunkHosts(ctx.db, input.id);
    const statuses = await getTrunkStatuses([input.id]);
    return mapTrunkRow(row, hosts, statuses[input.id] ?? UNKNOWN_STATUS);
  }
});
