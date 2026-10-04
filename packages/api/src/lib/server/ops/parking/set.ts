import { z } from 'zod';

import { HTTP_CONFLICT } from '@zamfono/shared';

import { recordChange } from '../audit.js';
import type { DroppedBlfKey } from '../devices/_shared.js';
import { propagate } from '../propagate.js';
import { pushRoster } from '../roster.js';
import { Conflict, defineOperation, type Context } from '../types.js';
import { assertValidExtension } from '../users/_extensions.js';
import { loadParkingSlots, slotsOutput } from './_shared.js';

/** An extension digit string, matching the `extensions.ext` CHECK (§11.2). */
const EXT_PATTERN = /^[0-9]+$/u;

const inputSchema = z
  .object({
    slots: z
      .array(z.string().regex(EXT_PATTERN))
      .refine(slots => new Set(slots).size === slots.length, {
        message: 'parking: duplicate slot'
      })
      .describe(
        "Every parking-slot extension, of the tenant's extension length; *70 parks a call on the lowest free slot, dialling a slot retrieves it, and settings.parkingTimeoutS rings the parker back."
      )
  })
  .strict();

/**
 * Refuses a new slot ext that already names a user's or ring group's extension (§10.3 "Parking"):
 * the primary key on `extensions.ext` would collide on insert otherwise.
 */
async function guardNoCollision(
  ctx: Context,
  additions: string[]
): Promise<void> {
  if (additions.length === 0) {
    return;
  }
  const owned = await ctx.db
    .selectFrom('extensions')
    .select(['ext', 'userId', 'ringGroupId'])
    .where('ext', 'in', additions)
    .execute();
  if (owned.length > 0) {
    throw new Conflict(
      'parking: extension already assigned',
      owned.map(row => ({
        kind: row.userId === null ? 'ringGroup' : 'user',
        id: row.userId ?? row.ringGroupId ?? row.ext,
        label: row.ext
      }))
    );
  }
}

/**
 * The `device_blf_keys` rows the FK cascade drops when `exts` slots are removed, captured before
 * the delete so the audit diff can record them (§5.9, §11.2 "extensions").
 */
async function loadDroppedBlfKeys(
  ctx: Context,
  exts: string[]
): Promise<DroppedBlfKey[]> {
  if (exts.length === 0) {
    return [];
  }
  return ctx.db
    .selectFrom('deviceBlfKeys')
    .select(['deviceId', 'ext', 'position'])
    .where('ext', 'in', exts)
    .execute();
}

/** `PUT /parking/slots` (§10.3 "Parking"): replaces the set of parking-slot extensions as a whole. */
export const set = defineOperation({
  name: 'parking.set',
  description:
    'Replaces the set of parking-slot extensions as a whole; an extension a user or ring group owns, or an emergency number, is refused',
  input: inputSchema,
  output: slotsOutput,
  problems: [HTTP_CONFLICT],
  minRole: 'admin',
  entity: () => ({ kind: 'parking', id: 'parking' }),
  run: async (ctx, input) => {
    const before = await loadParkingSlots(ctx.db);
    const beforeSet = new Set(before);
    const afterSet = new Set(input.slots);
    const additions = input.slots.filter(ext => !beforeSet.has(ext));
    const removals = before.filter(ext => !afterSet.has(ext));
    await Promise.all(additions.map(ext => assertValidExtension(ctx.db, ext)));
    await guardNoCollision(ctx, additions);
    const droppedBlfKeys = await loadDroppedBlfKeys(ctx, removals);
    if (removals.length > 0) {
      await ctx.db
        .deleteFrom('extensions')
        .where('ext', 'in', removals)
        .execute();
    }
    if (additions.length > 0) {
      await ctx.db
        .insertInto('extensions')
        .values(
          additions.map(ext => ({
            ext,
            userId: null,
            ringGroupId: null,
            isParkingSlot: 1
          }))
        )
        .execute();
    }
    recordChange(ctx, { field: 'slots', from: before, to: input.slots });
    if (droppedBlfKeys.length > 0) {
      recordChange(ctx, {
        field: 'droppedBlfKeys',
        from: droppedBlfKeys,
        to: []
      });
    }
    propagate(ctx, ['dialplan']);
    // The branch profile lists the slots under `callpark.slots` and the roster (§10.4).
    if (additions.length > 0 || removals.length > 0) {
      await pushRoster(ctx);
    }
    return { slots: await loadParkingSlots(ctx.db) };
  }
});
