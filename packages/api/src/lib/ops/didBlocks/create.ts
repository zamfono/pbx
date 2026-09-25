import { z } from 'zod';

import { newId, normalizeInbound } from '@zamfono/shared';

import {
  createTarget,
  targetInputSchema,
  type TargetInput
} from '../dids/_shared.js';
import { propagate, recordChange } from '../runner.js';
import { Conflict, defineOperation } from '../types.js';

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
      .refine(isGlobLiteral, 'base: no GLOB metacharacter'),
    label: z.string().nullable().optional(),
    digits: z.number().int().positive().nullable().optional(),
    fallbackTarget: targetInputSchema.nullable().optional()
  })
  .strict();

type Input = z.infer<typeof inputSchema>;

type CreateOutput = {
  id: string;
  base: string;
  label: string | null;
  digits: number | null;
  fallbackTarget: TargetInput | null;
  createdAt: string;
};

/** `POST /didBlocks` (§10.3 "Extensions & DIDs", §11.3): a number block and its fallback target. */
export const create = defineOperation<Input, CreateOutput>({
  name: 'didBlocks.create',
  description: 'Adds a number block',
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
    const existing = await ctx.db
      .selectFrom('didBlocks')
      .select('id')
      .where('base', '=', base)
      .where('deletedAt', 'is', null)
      .executeTakeFirst();
    if (existing) {
      throw new Conflict('didBlocks: base already in use', [
        { kind: 'didBlock', id: existing.id, label: base }
      ]);
    }
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
