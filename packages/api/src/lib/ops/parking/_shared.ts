import type { Db } from '@zamfono/shared';

/** The current set of parking-slot extensions, ascending (§10.2 "Call parking", §11.2 "extensions"). */
export async function loadParkingSlots(db: Db): Promise<string[]> {
  const rows = await db
    .selectFrom('extensions')
    .select('ext')
    .where('isParkingSlot', '=', 1)
    .orderBy('ext')
    .execute();
  return rows.map(row => row.ext);
}
