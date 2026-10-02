import * as env from '$app/env/private';

import { openDb, type Db } from '@zamfono/shared';

let processDb: Db | undefined;

/** The process-wide database handle, opened once from `DB_FILE` (§6.3; default set by the image's `ENV`). */
export function getDb(): Db {
  if (!processDb) {
    const file = env.DB_FILE;
    if (!file) {
      throw new Error('DB_FILE environment variable is required.');
    }
    processDb = openDb(file);
  }
  return processDb;
}
