import type { Selectable } from 'kysely';
import { z } from 'zod';

import { type DB, type Db } from '@zamfono/shared';

import { targetSpecSchema } from '../forwardTargetSchema.js';
import { rowToTarget } from '../forwardTargetSpec.js';
import { assertNoLiveHolder } from '../liveHolder.js';
import { liveRow } from '../rows.js';
import { timeoutSeconds } from '../timeoutInput.js';

/** A `menus` row as Kysely's `CamelCasePlugin` maps it (§11.2). */
export type MenuRow = Selectable<DB['menus']>;

/** Loads a live menu by id, or throws `OpError(404)`. */
export async function liveMenu(db: Db, id: string): Promise<MenuRow> {
  return liveRow(db, 'menus', id, `menu '${id}' not found`);
}

/** Throws 409 when `name` is already used by another live menu (`menus_name` partial UNIQUE, §11.2). */
export async function assertNameAvailable(
  db: Db,
  name: string,
  excludeId?: string
): Promise<void> {
  await assertNoLiveHolder(
    db,
    'menus: name already in use',
    { table: 'menus', kind: 'menu', label: 'name', values: { name } },
    excludeId
  );
}

/** The digit strings `menu_targets.digits` accepts: one or more of `0-9 * #` (§11.2). */
export const digitsSchema = z
  .string()
  .regex(/^[0-9*#]+$/u)
  .describe('The keys the caller presses, one or more of 0-9 * #.');

/**
 * The fields `menus.create` takes and `menus.update` takes each optionally (§10.1 step 6, §11.2
 * `menus`).
 */
export const menuFields = {
  name: z.string().min(1),
  audioId: z
    .string()
    .describe('The greeting, an audio asset of kind announcement.'),
  timeoutS: timeoutSeconds
    .optional()
    .describe(
      'Seconds to wait for the first key after the greeting; 5 by default.'
    ),
  maxAttempts: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      'Greeting replays on silence or an unmapped string before fallbackTarget applies; 3 by default.'
    ),
  allowExtensionDialing: z
    .boolean()
    .optional()
    .describe(
      'Lets an unmapped string that is a live user or ring-group extension route to it; off by default.'
    ),
  fallbackTarget: targetSpecSchema.describe(
    'Where the call goes after the last attempt.'
  )
};

/** One entry of a menu's DTMF map: the keys and the forward target they route to. */
export const menuTargetOut = z.object({
  digits: digitsSchema,
  target: targetSpecSchema
});
export type MenuTargetOut = z.infer<typeof menuTargetOut>;

/** A menu's DTMF map as `menus.setTargets` takes it and both target operations return it (§10.3). */
export const menuTargetsSchema = z
  .object({
    id: z.string(),
    targets: z
      .array(menuTargetOut)
      .describe(
        'Each key string and the forward target it routes to; a matched target re-enters routing without counting a hop.'
      )
  })
  .strict();

/** A menu's DTMF map in `menus.setTargets`' own input shape, ordered by digits (§10.3). */
export async function menuTargetRows(
  db: Db,
  menuId: string
): Promise<MenuTargetOut[]> {
  const rows = await db
    .selectFrom('menuTargets')
    .select(['digits', 'targetId'])
    .where('menuId', '=', menuId)
    .orderBy('digits')
    .execute();
  return Promise.all(
    rows.map(async row => ({
      digits: row.digits,
      target: rowToTarget(
        await db
          .selectFrom('forwardTargets')
          .selectAll()
          .where('id', '=', row.targetId)
          .executeTakeFirstOrThrow()
      )
    }))
  );
}

/** A menu's wire shape (§10.3), as `toMenuOut` assembles it. */
export const menuOut = z.object({
  id: z.string(),
  name: z.string(),
  audioId: z.string(),
  timeoutS: z.number(),
  maxAttempts: z.number(),
  allowExtensionDialing: z.boolean(),
  fallbackTarget: targetSpecSchema,
  targets: z.array(menuTargetOut)
});
export type MenuOut = z.infer<typeof menuOut>;

/** Assembles the wire shape of a menu from its row, fallback target and DTMF map (§10.3). */
export async function toMenuOut(db: Db, row: MenuRow): Promise<MenuOut> {
  const [fallback, targets] = await Promise.all([
    db
      .selectFrom('forwardTargets')
      .selectAll()
      .where('id', '=', row.fallbackTargetId)
      .executeTakeFirstOrThrow(),
    menuTargetRows(db, row.id)
  ]);
  return {
    id: row.id,
    name: row.name,
    audioId: row.audioId,
    timeoutS: row.timeoutS,
    maxAttempts: row.maxAttempts,
    allowExtensionDialing: row.allowExtensionDialing === 1,
    fallbackTarget: rowToTarget(fallback),
    targets
  };
}
