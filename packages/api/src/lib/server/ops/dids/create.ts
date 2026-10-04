import { z } from 'zod';

import {
  HTTP_CONFLICT,
  HTTP_NOT_FOUND,
  newId,
  normalizeInbound
} from '@zamfono/shared';

import { createTarget } from '../forwardTargets.js';
import { targetSpecSchema } from '../forwardTargetSchema.js';
import { assertNoLiveHolder } from '../liveHolder.js';
import { propagate } from '../propagate.js';
import { defineOperation } from '../types.js';
import { setCallerIdIfUnset } from './_callerId.js';
import { didOut, type DidOut } from './_shared.js';

const inputSchema = z
  .object({
    number: z
      .string()
      .min(1)
      .regex(/^\S+$/u, 'number: no whitespace')
      .describe(
        "The called number: E.164 such as +4989123456, or national such as 089123456, normalized with settings.country; anything else, such as a provider's account name, is matched verbatim."
      ),
    label: z.string().nullable().optional(),
    target: targetSpecSchema.describe(
      'Where a call to this number goes; a numeric DID for a user with no caller ID of their own becomes it.'
    )
  })
  .strict();

/** `POST /dids` (§10.3 "Extensions & DIDs", §11.3): a DID and the forward target it dials to. */
export const create = defineOperation({
  name: 'dids.create',
  description:
    'Adds a DID, a phone number the tenant owns, and the forward target its calls go to (zamfono.help numbers)',
  input: inputSchema,
  output: didOut,
  problems: [HTTP_NOT_FOUND, HTTP_CONFLICT],
  minRole: 'admin',
  entity: (_input, output) => ({ kind: 'did', id: output.id }),
  run: async (ctx, input) => {
    const settings = await ctx.db
      .selectFrom('settings')
      .select('country')
      .executeTakeFirstOrThrow();
    const number = normalizeInbound(input.number, 'national', settings.country);
    await assertNoLiveHolder(ctx.db, 'dids: number already in use', {
      table: 'dids',
      kind: 'did',
      label: 'number',
      values: { number }
    });
    const targetId = await createTarget(ctx, input.target);
    const id = newId();
    const label = input.label ?? null;
    await ctx.db
      .insertInto('dids')
      .values({ id, number, label, targetId, createdAt: ctx.now })
      .execute();
    if (input.target.kind === 'user') {
      await setCallerIdIfUnset(ctx, input.target.userId, id, number);
    }
    const output: DidOut = {
      id,
      number,
      label,
      target: input.target,
      createdAt: ctx.now
    };
    // Read by the routing pipeline (§3.1), and nothing in it reaches Asterisk's own
    // configuration, so this drops `core`'s config cache without a reload.
    propagate(ctx, []);
    return output;
  }
});
