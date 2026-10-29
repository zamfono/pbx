import { describe, expect, it } from 'vitest';

import { authenticateToken } from '#lib/server/auth/bearer.js';
import { handleRest } from '#lib/server/rest.js';
import { asRun, makeTestDb, owner } from '#testing/testDb.js';

import { runOperation } from '../runner.js';

import './index.js';

const deps = { requestId: 'req-1' };

describe('personalAccessTokens.current', () => {
  it('answers GET /personalAccessTokens/current with the token the caller presented', async () => {
    const db = await makeTestDb();
    const created = (await runOperation(
      db,
      'personalAccessTokens.create',
      { userId: owner.id, name: 'crm-sync' },
      asRun()
    )) as { id: string; token: string };
    const auth = await authenticateToken(
      { db, jwtSecret: 'unused' },
      created.token
    );

    const response = await handleRest(
      new Request('http://api/api/v1/personalAccessTokens/current'),
      auth?.actor ?? null,
      { db, ...deps }
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      id: created.id,
      userId: owner.id,
      name: 'crm-sync'
    });
    expect(body).not.toHaveProperty('token');
  });

  it('answers 404 to a caller that authenticated otherwise', async () => {
    const db = await makeTestDb();
    const response = await handleRest(
      new Request('http://api/api/v1/personalAccessTokens/current'),
      owner,
      { db, ...deps }
    );
    expect(response.status).toBe(404);
  });
});
