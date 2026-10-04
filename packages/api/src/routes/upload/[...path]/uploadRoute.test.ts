import process from 'node:process';
import { beforeAll, describe, expect, it, vi } from 'vitest';

import { epochSeconds, newId, nowIso } from '@zamfono/shared';
import { migrateForTest } from '@zamfono/shared/testDb.js';

import { encodeLinkToken } from '#lib/server/auth/jwt.js';
import { getDb } from '#lib/server/db.js';
import { requestEvent } from '#testing/requestEvent.js';

import { POST } from './+server.js';

const ORIGIN = 'https://pbx.example';
const JWT_SECRET = 'test-secret';

process.env.DB_FILE = ':memory:';
process.env.JWT_SECRET = JWT_SECRET;
process.env.FQDN = 'pbx.example';

vi.mock('#lib/server/audio/store.js', () => ({
  storeAudio: vi.fn(async (kind: string, upload: { filename: string }) =>
    Promise.resolve({ id: newId(), filename: `${kind}-${upload.filename}.wav` })
  ),
  deleteAudioFile: vi.fn(async () => Promise.resolve())
}));

beforeAll(async () => {
  const db = getDb();
  await migrateForTest(db);
  await db
    .insertInto('users')
    .values({
      id: 'admin1',
      name: 'Admin',
      email: 'admin@x',
      role: 'admin',
      passwordHash: 'x',
      createdAt: nowIso()
    })
    .execute();
});

async function uploadUrl(aud: string): Promise<URL> {
  const nowS = epochSeconds(Date.now());
  const token = await encodeLinkToken(JWT_SECRET, 'upload', {
    sub: 'admin1',
    cid: null,
    aud,
    iat: nowS,
    exp: nowS + 300
  });
  return new URL(
    `${ORIGIN}/upload/audio?kind=moh&label=Hold&access_token=${token}`
  );
}

async function post(url: URL): Promise<Response> {
  const form = new FormData();
  form.set('upload', new File(['x'], 'hold.wav', { type: 'audio/wav' }));
  return POST(
    requestEvent<Parameters<typeof POST>[0]>(url, {
      init: { method: 'POST', body: form }
    })
  );
}

describe('POST <upload link> (§10.5 "Uploads")', () => {
  it('runs the operation with the posted file, kept from shared caches', async () => {
    const response = await post(await uploadUrl('/api/v1/audio'));
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('private');
    expect(await response.json()).toMatchObject({ kind: 'moh', label: 'Hold' });
  });

  it('answers a token signed for another path with 401', async () => {
    const response = await post(await uploadUrl('/api/v1/users'));
    expect(response.status).toBe(401);
  });
});
