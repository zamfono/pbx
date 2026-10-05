import process from 'node:process';
import { beforeAll, describe, expect, it, vi } from 'vitest';

import { epochSeconds, newId, nowIso } from '@zamfono/shared';
import { migrateForTest, seedSettings } from '@zamfono/shared/testDb.js';

import { dictionaryFor } from '#lib/i18n/index.js';
import { encodeLinkToken } from '#lib/server/auth/jwt.js';
import { getDb } from '#lib/server/db.js';

import { upload } from './upload.remote.js';

const JWT_SECRET = 'test-secret';

process.env.DB_FILE = ':memory:';
process.env.JWT_SECRET = JWT_SECRET;
process.env.FQDN = 'pbx.example';

// `form` hands back the handler behind its schema, so a test calls the form's body with the
// payload SvelteKit would have parsed. The `__.type` marker is what SvelteKit's own check of a
// `.remote.ts` module's exports looks for.
vi.mock('$app/server', () => ({
  form: (
    schema: { parse: (input: unknown) => unknown },
    handler: (payload: unknown) => Promise<unknown>
  ) =>
    Object.assign((input: unknown) => handler(schema.parse(input)), {
      __: { type: 'form' }
    })
}));

vi.mock('#lib/server/audio/store.js', () => ({
  storeAudio: vi.fn(async (kind: string, file: { filename: string }) =>
    Promise.resolve({ id: newId(), filename: `${kind}-${file.filename}.wav` })
  ),
  deleteAudioFile: vi.fn(async () => Promise.resolve())
}));

const submit = upload as unknown as (
  payload: Record<string, unknown>
) => Promise<unknown>;

beforeAll(async () => {
  const db = getDb();
  await migrateForTest(db);
  await seedSettings(db, { language: 'de' });
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
  await db
    .insertInto('users')
    .values({
      id: 'user1',
      name: 'User',
      email: 'user@x',
      role: 'user',
      passwordHash: 'x',
      createdAt: nowIso()
    })
    .execute();
});

async function linkToken(expiresInS: number, sub = 'admin1'): Promise<string> {
  const nowS = epochSeconds(Date.now());
  return encodeLinkToken(JWT_SECRET, 'upload', {
    sub,
    cid: null,
    aud: '/api/v1/audio',
    iat: nowS - 600,
    exp: nowS + expiresInS
  });
}

describe('the upload page form (§10.5 "Uploads")', () => {
  it('says the link has expired, in the tenant language, when it expired after the page opened', async () => {
    const token = await linkToken(-300);
    const outcome = await submit({
      link: `/upload/audio?kind=moh&label=Hold&access_token=${token}`,
      upload: new File(['x'], 'hold.wav', { type: 'audio/wav' })
    });
    expect(outcome).toEqual({ refusal: dictionaryFor('de').upload.expired });
  });

  it('says only WAV and MP3 are taken, in the tenant language, for another type', async () => {
    const outcome = await submit({
      link: `/upload/audio?kind=moh&label=Hold&access_token=${await linkToken(300)}`,
      upload: new File(['x'], 'hold.txt', { type: 'text/plain' })
    });
    expect(outcome).toEqual({ refusal: dictionaryFor('de').upload.invalid });
  });

  it('says the account may not upload, in the tenant language, for a role below the operation', async () => {
    const outcome = await submit({
      link: `/upload/audio?kind=moh&label=Hold&access_token=${await linkToken(300, 'user1')}`,
      upload: new File(['x'], 'hold.wav', { type: 'audio/wav' })
    });
    expect(outcome).toEqual({ refusal: dictionaryFor('de').upload.forbidden });
  });
});
