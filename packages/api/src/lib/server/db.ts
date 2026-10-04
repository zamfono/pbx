import * as env from '$app/env/private';

import { openDb, type Db } from '@zamfono/shared';

let processDb: Db | undefined;

/** The process-wide database handle, opened once from `DB_FILE` (§6.3; default in `src/env.ts`). */
export function getDb(): Db {
  processDb ??= openDb(env.DB_FILE);
  return processDb;
}
