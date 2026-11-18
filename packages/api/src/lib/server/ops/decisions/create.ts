import { z } from 'zod';

import { HTTP_CONFLICT, HTTP_NOT_FOUND, newId } from '@zamfono/shared';

import { recordChange } from '../audit.js';
import { insertForwardTarget } from '../forwardTargetSpec.js';
import { insertOwnedExtension } from '../ownedExtension.js';
import { propagate } from '../propagate.js';
import { defineOperation } from '../types.js';
import {
  assertNameAvailable,
  decisionFields,
  decisionOut,
  insertCases,
  liveDecision,
  toDecisionOut,
  type DecisionOut
} from './_shared.js';

export const decisionInputSchema = z
  .object({
    name: decisionFields.name,
    cases: decisionFields.cases.default([]),
    default: decisionFields.default,
    extension: decisionFields.extension.optional()
  })
  .strict();

/** `POST /decisions` (§10.1 step 7 "Decisions", §10.3): a decision, with an extension only where
 * one is given. */
export const createDecision = defineOperation({
  name: 'decisions.create',
  description:
    'Creates a decision: ordered cases, each a set of conditions and a target, and a default target for a call no case matches.',
  input: decisionInputSchema,
  output: decisionOut,
  problems: [HTTP_NOT_FOUND, HTTP_CONFLICT],
  minRole: 'admin',
  entity: (_input, out: DecisionOut) => ({ kind: 'decision', id: out.id }),
  run: async (ctx, input) => {
    await assertNameAvailable(ctx.db, input.name);
    const id = newId();
    const defaultTargetId = await insertForwardTarget(ctx, input.default);
    await ctx.db
      .insertInto('decisions')
      .values({ id, name: input.name, defaultTargetId, createdAt: ctx.now })
      .execute();
    await insertCases(ctx, id, input.cases);
    recordChange(ctx, { field: 'name', from: null, to: input.name });
    await insertOwnedExtension(
      ctx,
      { decisionId: id },
      input.extension ?? null
    );
    // Read by the routing pipeline (§3.1); an extension's hint reloads the dialplan as well.
    propagate(ctx, []);
    return toDecisionOut(ctx.db, await liveDecision(ctx.db, id));
  }
});
