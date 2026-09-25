import type { Db } from '@zamfono/shared';

const PARKING_SLOT_COUNT = 9;
// The extension length's floor (§11.4 `ext_length >= 2`) is what leaves room for the nine slots.
const PARKING_EXT_LENGTH_FLOOR = 2;

/**
 * The owner's extension (§6.3 "First boot"): the highest of the tenant's extension length less
 * one — 98, 998, 9998. All nines is left free because `999` is the emergency number in several
 * countries, and an internal extension must never shadow one. Every live user owns exactly one
 * `extensions` row (§11.2), which is what makes them dialable internally and what `GET /users`
 * reports, so the first user is given one here rather than at the first login.
 */
export async function createOwnerExtension(
  db: Db,
  ownerId: string,
  extLength: number
): Promise<void> {
  await db
    .insertInto('extensions')
    .values({
      ext: `${'9'.repeat(extLength - 1)}8`,
      userId: ownerId,
      ringGroupId: null,
      isParkingSlot: 0
    })
    .execute();
}

/** Nine parking-slot extensions (§10.2, §6.3 "First boot"): `7` + zeros + digits 1 to 9. */
export async function createParkingSlots(
  db: Db,
  extLength: number
): Promise<void> {
  const zeros = '0'.repeat(extLength - PARKING_EXT_LENGTH_FLOOR);
  const rows = Array.from({ length: PARKING_SLOT_COUNT }, (_slot, index) => ({
    ext: `7${zeros}${index + 1}`,
    userId: null,
    ringGroupId: null,
    isParkingSlot: 1
  }));
  await db.insertInto('extensions').values(rows).execute();
}
