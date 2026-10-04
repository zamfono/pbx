import { z } from 'zod';

import { HTTP_NOT_FOUND } from '@zamfono/shared';

import { defineOperation } from '../types.js';
import { liveRingGroup, ringGroupOut, toRingGroupOut } from './_shared.js';

export const getRingGroup = defineOperation({
  name: 'ringGroups.get',
  description: 'Reads one live ring group by id.',
  input: z.object({ id: z.string() }),
  output: ringGroupOut,
  problems: [HTTP_NOT_FOUND],
  minRole: 'admin',
  readOnly: true,
  run: async (ctx, input) => {
    const row = await liveRingGroup(ctx.db, input.id);
    return toRingGroupOut(ctx.db, row);
  }
});
