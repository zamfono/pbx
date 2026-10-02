import type { Selectable } from 'kysely';

import type { DB } from '@zamfono/shared';

export type BlockedNumberRow = Selectable<DB['blockedNumbers']>;
