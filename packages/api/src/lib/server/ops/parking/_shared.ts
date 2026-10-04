import { z } from 'zod';

import type { Db } from '@zamfono/shared';

/** The set of parking-slot extensions, as `parking.get` and `parking.set` answer it. */
export const slotsOutput = z.object({ slots: z.array(z.string()) });

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
