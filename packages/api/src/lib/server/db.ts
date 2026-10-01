import { env } from '$env/dynamic/private';

import { openDb, type Db } from '@zamfono/shared';

const cache: { db?: Db } = {};

/** The process-wide database handle, opened once from `DB_FILE` (§6.3; default set by the image's `ENV`). */
export function getDb(): Db {
  if (!cache.db) {
    const file = env.DB_FILE;
    if (!file) {
      throw new Error('DB_FILE environment variable is required.');
    }
    cache.db = openDb(file);
  }
  return cache.db;
}
