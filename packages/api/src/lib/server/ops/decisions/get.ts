import { z } from 'zod';

import { HTTP_NOT_FOUND } from '@zamfono/shared';

import { defineOperation } from '../types.js';
import { decisionOut, liveDecision, toDecisionOut } from './_shared.js';

export const getDecision = defineOperation({
  name: 'decisions.get',
  description: 'Reads one live decision by id.',
  input: z.object({ id: z.string() }).strict(),
  output: decisionOut,
  problems: [HTTP_NOT_FOUND],
  minRole: 'admin',
  readOnly: true,
  run: async (ctx, input) =>
    toDecisionOut(ctx.db, await liveDecision(ctx.db, input.id))
});
