import process from 'node:process';
import { describe, expect, it } from 'vitest';

import { HTTP_SERVICE_UNAVAILABLE } from '@zamfono/shared';
import { MIGRATIONS_DIR } from '@zamfono/shared/testDb.js';

import { GET } from './+server.js';

// `getDb()` reads `DB_FILE` once per process: an in-memory database holding no migration record.
process.env.DB_FILE = ':memory:';
process.env.MIGRATIONS_DIR = MIGRATIONS_DIR;

describe('GET /readyz', () => {
  it('is 503 with an empty body while a migration is pending', async () => {
    const response = await GET();
    expect(response.status).toBe(HTTP_SERVICE_UNAVAILABLE);
    expect(await response.text()).toBe('');
  });
});
