import {
  emergencyNumbersColumn,
  HTTP_UNPROCESSABLE_CONTENT,
  type Db
} from '@zamfono/shared';

import { Conflict, OpError } from '../types.js';

/** The extension a live user owns (§11.2 `extensions`): at most one, `null` for none. */
export async function userExtension(
  db: Db,
  userId: string
): Promise<string | null> {
  const row = await db
    .selectFrom('extensions')
    .select('ext')
    .where('userId', '=', userId)
    .executeTakeFirst();
  return row?.ext ?? null;
}

/**
 * The extension of `user`, for what only a user with one has (§11.2): a device, which is named
 * after it, and a ring-group membership. Throws `Conflict(409)` naming the user without one.
 */
export async function requireUserExtension(
  db: Db,
  user: { id: string; name: string },
  what: string
): Promise<string> {
  const ext = await userExtension(db, user.id);
  if (ext === null) {
    throw new Conflict(
      `${what}: the user has no extension; give them one first`,
      [{ kind: 'user', id: user.id, label: user.name }]
    );
  }
  return ext;
}

/**
 * Throws `OpError(422)` unless `ext` is digits-only and of the tenant's fixed length (§11.2), and
 * is not one of `settings.emergency_numbers_json`: an emergency number is "always external and
 * never a valid extension" (§9.4 "Dial-plan resolution"), and dialling resolves it as the
 * emergency call before it ever reaches an extension, so such a row would be unreachable.
 */
export async function assertValidExtension(db: Db, ext: string): Promise<void> {
  const settings = await db
    .selectFrom('settings')
    .select(['extLength', 'emergencyNumbersJson'])
    .where('id', '=', 1)
    .executeTakeFirstOrThrow();
  if (!/^[0-9]+$/u.test(ext) || ext.length !== settings.extLength) {
    throw new OpError(
      HTTP_UNPROCESSABLE_CONTENT,
      `extension must be ${settings.extLength} digits`
    );
  }
  const emergency = emergencyNumbersColumn.decode(
    settings.emergencyNumbersJson
  );
  if (emergency.includes(ext)) {
    throw new OpError(
      HTTP_UNPROCESSABLE_CONTENT,
      `${ext} is an emergency number and cannot be an extension`
    );
  }
}

/** The `{kind, id}` a live `extensions` row names as its owner (§11.2: user, ring group, or a parking slot). */
function extensionReference(
  ext: string,
  row: { userId: string | null; ringGroupId: string | null }
): { kind: string; id: string } {
  if (row.userId !== null) {
    return { kind: 'user', id: row.userId };
  }
  if (row.ringGroupId !== null) {
    return { kind: 'ringGroup', id: row.ringGroupId };
  }
  return { kind: 'parkingSlot', id: ext };
}

/**
 * Throws `OpError(409)` when `ext` is already a live extension, naming its current owner
 * (§5.9's own-name-and-number rule; the extensions PK enforces this, this refusal is the friendly
 * form of it).
 */
export async function assertExtensionAvailable(
  db: Db,
  ext: string
): Promise<void> {
  const existing = await db
    .selectFrom('extensions')
    .select(['ext', 'userId', 'ringGroupId'])
    .where('ext', '=', ext)
    .executeTakeFirst();
  if (existing) {
    throw new Conflict('users: extension already in use', [
      { ...extensionReference(ext, existing), label: `extension ${ext}` }
    ]);
  }
}
