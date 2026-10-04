import type { Selectable } from 'kysely';
import { z } from 'zod';

import type { DB } from '@zamfono/shared';

export type BlockedNumberRow = Selectable<DB['blockedNumbers']>;

/** A blocklist entry's wire shape (§10.3 "Blocklist"). */
export const blockedNumberWire = z.object({
  id: z.string(),
  number: z.string(),
  isPrefix: z.boolean(),
  label: z.string().nullable(),
  createdAt: z.string()
});
