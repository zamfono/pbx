import type { Selectable, Transaction } from 'kysely';
import { z } from 'zod';

import type { DB } from '@zamfono/shared';

import {
  deleteForwardTarget,
  insertForwardTarget,
  rowToTarget,
  targetSpecSchema,
  type TargetSpec
} from '../forwardTargetSpec.js';
import { Conflict, OpError } from '../types.js';

export {
  targetSpecSchema,
  insertForwardTarget,
  deleteForwardTarget,
  rowToTarget
};
export type { TargetSpec };

const STATUS_NOT_FOUND = 404;

/** A `menus` row as Kysely's `CamelCasePlugin` maps it (§11.2). */
export type MenuRow = Selectable<DB['menus']>;

/**
 * Throws 404 when `audioId` names no live `audio_assets` row of kind `announcement` (`menus.audio_id`,
 * §11.2 `ON DELETE RESTRICT`; §11.2 "audio_id: the greeting, an audio_assets row of kind 'announcement'").
 */
export async function assertAudioAvailable(
  db: Transaction<DB>,
  audioId: string
): Promise<void> {
  const row = await db
    .selectFrom('audioAssets')
    .select('id')
    .where('id', '=', audioId)
    .where('kind', '=', 'announcement')
    .where('deletedAt', 'is', null)
    .executeTakeFirst();
  if (!row) {
    throw new OpError(
      STATUS_NOT_FOUND,
      `announcement audio asset '${audioId}' not found`
    );
  }
}

/** Throws 409 when `name` is already used by another live menu (`menus_name` partial UNIQUE, §11.2). */
export async function assertNameAvailable(
  db: Transaction<DB>,
  name: string,
  excludeId?: string
): Promise<void> {
  let query = db
    .selectFrom('menus')
    .select(['id', 'name'])
    .where('name', '=', name)
    .where('deletedAt', 'is', null);
  if (excludeId !== undefined) {
    query = query.where('id', '!=', excludeId);
  }
  const existing = await query.executeTakeFirst();
  if (existing) {
    throw new Conflict('menus: name already in use', [
      { kind: 'menu', id: existing.id, label: existing.name }
    ]);
  }
}

/** The digit strings `menu_targets.digits` accepts: one or more of `0-9 * #` (§11.2). */
export const digitsSchema = z.string().regex(/^[0-9*#]+$/u);

export type MenuTargetOut = { digits: string; target: TargetSpec };

/** A menu's DTMF map in `menus.setTargets`' own input shape, ordered by digits (§10.3). */
export async function menuTargetRows(
  db: Transaction<DB>,
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

export type MenuOut = {
  id: string;
  name: string;
  audioId: string;
  timeoutS: number;
  maxAttempts: number;
  allowExtensionDialing: boolean;
  fallbackTarget: TargetSpec;
  targets: MenuTargetOut[];
};

/** Assembles the wire shape of a menu from its row, fallback target and DTMF map (§10.3). */
export async function toMenuOut(
  db: Transaction<DB>,
  row: MenuRow
): Promise<MenuOut> {
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
