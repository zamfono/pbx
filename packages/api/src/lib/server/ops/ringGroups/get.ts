import { z } from 'zod';

import { defineOperation } from '../types.js';
import { liveRingGroup, toRingGroupOut } from './_shared.js';

export const getRingGroup = defineOperation({
  name: 'ringGroups.get',
  description: 'Reads one live ring group by id.',
  input: z.object({ id: z.string() }),
  minRole: 'admin',
  readOnly: true,
  run: async (ctx, input) => {
    const row = await liveRingGroup(ctx.db, input.id);
    return toRingGroupOut(ctx.db, row);
  }
});
