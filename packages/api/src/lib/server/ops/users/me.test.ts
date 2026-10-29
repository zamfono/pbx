import { describe, expect, it } from 'vitest';

import { seedUser } from '@zamfono/shared/testDb.js';

import { handleRest } from '#lib/server/rest.js';
import { makeTestDb } from '#testing/testDb.js';

describe('users.me', () => {
  it('answers GET /users/me with the profile of the user the caller acts as', async () => {
    const db = await makeTestDb();
    const id = await seedUser(db, { name: 'Anna Huber', role: 'user' });

    const response = await handleRest(
      new Request('http://api/api/v1/users/me'),
      { id, name: 'Anna Huber', role: 'user' },
      { db, requestId: 'req-1' }
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      id,
      name: 'Anna Huber',
      role: 'user'
    });
  });
});
