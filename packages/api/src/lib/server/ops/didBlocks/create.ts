import { z } from 'zod';

import { newId, normalizeInbound } from '@zamfono/shared';

import { recordChange } from '../audit.js';
import { createTarget } from '../forwardTargets.js';
import { type TargetSpec } from '../forwardTargetSchema.js';
import { assertNoLiveHolder } from '../liveHolder.js';
import { propagate } from '../propagate.js';
import { defineOperation } from '../types.js';
import { DIGITS_SCHEMA, FALLBACK_TARGET_SCHEMA } from './_shared.js';

/**
 * The characters SQLite's `GLOB` reads as wildcards. The `did_blocks` soft-delete guard matches a
 * block's DIDs with `number GLOB base || '*'` (§11.3), which a base carrying one of these would
 * widen beyond the block.
 */
const GLOB_METACHARACTERS = ['*', '?', '[', ']'];

/** Whether `value` is free of GLOB metacharacters. */
function isGlobLiteral(value: string): boolean {
  return !GLOB_METACHARACTERS.some(character => value.includes(character));
}

const inputSchema = z
  .object({
    base: z
      .string()
      .min(1)
      .regex(/^\S+$/u, 'base: no whitespace')
      .refine(isGlobLiteral, 'base: no GLOB metacharacter')
      .describe(
        'What every number in the block begins with: E.164 such as +4989123470, or national such as 089123470, normalized with settings.country; immutable.'
      ),
    label: z.string().nullable().optional(),
    digits: DIGITS_SCHEMA,
    fallbackTarget: FALLBACK_TARGET_SCHEMA
  })
  .strict();

type Input = z.infer<typeof inputSchema>;

type CreateOutput = {
  id: string;
  base: string;
  label: string | null;
  digits: number | null;
  fallbackTarget: TargetSpec | null;
  createdAt: string;
};

/** `POST /didBlocks` (§10.3 "Extensions & DIDs", §11.3): a number block and its fallback target. */
export const create = defineOperation<Input, CreateOutput>({
  name: 'didBlocks.create',
  description:
    'Adds a number block: a base and a fixed digit count, or open-ended; groups DIDs and gives unassigned numbers in it a fallback (zamfono.help numbers)',
  input: inputSchema,
  minRole: 'admin',
  entity: (_input, output: CreateOutput) => ({
    kind: 'didBlock',
    id: output.id
  }),
  run: async (ctx, input) => {
    const settings = await ctx.db
      .selectFrom('settings')
      .select('country')
      .executeTakeFirstOrThrow();
    // A block covers the DIDs whose number begins with its base (§11.3), so base and number are
    // stored in the same international form `dids.create` normalizes a number to.
    const base = normalizeInbound(input.base, 'national', settings.country);
    await assertNoLiveHolder(ctx.db, 'didBlocks: base already in use', {
      table: 'didBlocks',
      kind: 'didBlock',
      label: 'base',
      values: { base }
    });
    const fallbackTargetId = input.fallbackTarget
      ? await createTarget(ctx, input.fallbackTarget)
      : null;
    const id = newId();
    const label = input.label ?? null;
    const digits = input.digits ?? null;
    await ctx.db
      .insertInto('didBlocks')
      .values({
        id,
        base,
        label,
        digits,
        fallbackTargetId,
        createdAt: ctx.now
      })
      .execute();
    recordChange(ctx, { field: 'base', from: null, to: base });
    // Read by the routing pipeline (§3.1), and nothing in it reaches Asterisk's own
    // configuration, so this drops `core`'s config cache without a reload.
    propagate(ctx, []);
    return {
      id,
      base,
      label,
      digits,
      fallbackTarget: input.fallbackTarget ?? null,
      createdAt: ctx.now
    };
  }
});
