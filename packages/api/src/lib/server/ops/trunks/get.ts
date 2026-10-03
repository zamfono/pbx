import { z } from 'zod';

import { HTTP_NOT_FOUND } from '@zamfono/shared';

import { defineOperation, OpError } from '../types.js';
import {
  loadTrunkHosts,
  loadTrunkRow,
  mapTrunkRow,
  type TrunkWire
} from './_shared.js';
import { getTrunkStatuses, UNKNOWN_STATUS } from './_status.js';

const inputSchema = z.object({ id: z.string().min(1) }).strict();
type Input = z.infer<typeof inputSchema>;

export const get = defineOperation<Input, TrunkWire>({
  name: 'trunks.get',
  description: 'Reads one SIP trunk.',
  input: inputSchema,
  minRole: 'admin',
  readOnly: true,
  run: async (ctx, input) => {
    const row = await loadTrunkRow(ctx.db, input.id);
    if (!row) {
      throw new OpError(HTTP_NOT_FOUND, 'trunk not found');
    }
    const hosts = await loadTrunkHosts(ctx.db, input.id);
    const statuses = await getTrunkStatuses([input.id]);
    return mapTrunkRow(row, hosts, statuses[input.id] ?? UNKNOWN_STATUS);
  }
});
