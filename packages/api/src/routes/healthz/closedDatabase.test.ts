import { randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { describe, expect, it } from 'vitest';

import { HTTP_SERVICE_UNAVAILABLE, type HealthDocument } from '@zamfono/shared';
import { MIGRATIONS_DIR } from '@zamfono/shared/testDb.js';

import { GET as readyz } from '../readyz/+server.js';
import { GET as healthz } from './+server.js';

const KEY_BYTE_LENGTH = 32;

// `getDb()` reads `DB_FILE` once per process: a file in a directory that does not exist, which
// SQLite cannot open.
process.env.DB_FILE = path.join(
  mkdtempSync(path.join(tmpdir(), 'zamfono-closed-')),
  'missing',
  'zamfono.db'
);
process.env.MIGRATIONS_DIR = MIGRATIONS_DIR;
process.env.SECRETBOX_KEY = `1:${randomBytes(KEY_BYTE_LENGTH).toString('base64')}`;

describe('a database that cannot be opened', () => {
  it('fails GET /healthz with database:status closed, the table checks left out', async () => {
    const response = await healthz();
    expect(response.status).toBe(HTTP_SERVICE_UNAVAILABLE);
    const { checks } = (await response.json()) as HealthDocument;
    expect(checks['database:status']).toEqual([
      { status: 'fail', output: 'closed' }
    ]);
    expect(checks).not.toHaveProperty('trunks:emergency');
  });

  it('is 503 on GET /readyz', async () => {
    const response = await readyz();
    expect(response.status).toBe(HTTP_SERVICE_UNAVAILABLE);
  });
});
