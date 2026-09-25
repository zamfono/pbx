import type { Selectable } from 'kysely';

import type { DB } from '@zamfono/shared';

export type BlockedNumberRow = Selectable<DB['blockedNumbers']>;

/** A caller number as the trunk boundary produces it: `+` followed by digits only (§11.2). */
export const E164_PATTERN = /^\+[0-9]+$/u;
