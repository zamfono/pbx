import { describe, expect, it } from 'vitest';

import { createTrunk } from '#testing/fixtures.js';
import { asRun, makeTestDb } from '#testing/testDb.js';

import { runOperation } from '../runner.js';

import '../outboundRoutes/index.js';
import './index.js';

// RFC 3261 §25.1 `user`: alphanumerics, the marks `-_.!~*'()`, the user-unreserved `&=+$,;?/`
// and `%` escapes, so every class appears here at least once.
const ACCEPTED = [
  'acct4711',
  "a-b_c.d!e~f*g'h(i)j",
  'a&b=c+d$e,f;g?h/i',
  'acct%40example'
];

const REFUSED = [
  'a<b',
  'a>b',
  'a"b',
  'a#b',
  'a:b',
  'a%b',
  'a%4',
  'a%zz',
  'a b',
  'a@b',
  'a[b',
  'a]b',
  'a\\b',
  'a`b',
  'a^b',
  'a{b',
  'a|b',
  'a}b',
  'aäb',
  'a\nb'
];

describe('trunk username (§9.4 "Auth mode")', () => {
  it.each(REFUSED)(
    'refuses %j, no SIP URI user character, on create and update',
    async username => {
      const db = await makeTestDb();
      await expect(
        createTrunk(db, {
          authMode: 'registration',
          username,
          password: 'secret'
        })
      ).rejects.toMatchObject({ status: 422 });
      const { trunk } = await createTrunk(db, {
        authMode: 'registration',
        username: 'bob',
        password: 'secret'
      });
      await expect(
        runOperation(db, 'trunks.update', { id: trunk.id, username }, asRun())
      ).rejects.toMatchObject({ status: 422 });
    }
  );

  it.each(ACCEPTED)(
    'accepts %j, made of SIP URI user characters, on create and update',
    async username => {
      const db = await makeTestDb();
      await expect(
        createTrunk(db, {
          authMode: 'registration',
          username,
          password: 'secret'
        })
      ).resolves.toBeDefined();
      const { trunk } = await createTrunk(db, {
        name: 'Provider B',
        authMode: 'registration',
        username: 'bob',
        password: 'secret'
      });
      await expect(
        runOperation(db, 'trunks.update', { id: trunk.id, username }, asRun())
      ).resolves.toBeDefined();
    }
  );

  // Asterisk keeps a section name in 80 bytes, its NUL included (main/config.c `ast_category`), and
  // an inbound-auth trunk's username names its endpoint's section (§9.4 "Inbound identification").
  it('refuses an inbound-auth username of 80 bytes and accepts one of 79, on create and update', async () => {
    const db = await makeTestDb();
    const inboundAuth = { inboundAuth: true, password: 'secret' };
    await expect(
      createTrunk(db, { ...inboundAuth, username: 'a'.repeat(80) })
    ).rejects.toMatchObject({ status: 422 });
    const { trunk } = await createTrunk(db, {
      ...inboundAuth,
      username: 'a'.repeat(79)
    });
    await expect(
      runOperation(
        db,
        'trunks.update',
        { id: trunk.id, username: 'b'.repeat(80) },
        asRun()
      )
    ).rejects.toMatchObject({ status: 422 });
  });
});
