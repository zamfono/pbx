import { describe, expect, it, vi } from 'vitest';

import { newId, nowIso, type Db } from '@zamfono/shared';

import { makeTestDb } from '$lib/server/testDb.js';

import { sipUsernameOrFresh, uniqueSipUsername } from './_sipUsername.js';

// The slugs the generator draws, in order, so a collision is reproducible.
const slugs = vi.hoisted(() => ({ next: [] as string[] }));
vi.mock('$lib/server/sip.js', async importOriginal => ({
  ...(await importOriginal<typeof import('$lib/server/sip.js')>()),
  newSlug: () => slugs.next.shift() ?? 'zzzzz'
}));

/** A live trunk whose `username` is `username`, identified by digest when `inboundAuth` is set. */
async function seedTrunk(
  db: Db,
  username: string,
  inboundAuth: boolean
): Promise<void> {
  await db
    .insertInto('trunks')
    .values({
      id: newId(),
      name: `trunk-of-${username}-${String(inboundAuth)}`,
      priority: 1,
      emergency: 1,
      authMode: 'registration',
      username,
      passwordEnc: Buffer.from('placeholder'),
      inboundAuth: inboundAuth ? 1 : 0,
      transport: 'udp',
      outboundProxy: null,
      registerExpiryS: 3600,
      registerRetryS: 60,
      codecsJson: null,
      createdAt: nowIso()
    })
    .execute();
}

describe("a device's generated SIP username (§9.4 Inbound identification)", () => {
  it('skips a candidate an inbound-auth trunk already names its endpoint with', async () => {
    const db = await makeTestDb();
    await seedTrunk(db, 'e101-daaaaa', true);
    slugs.next = ['aaaaa', 'bbbbb'];
    const username = await db
      .transaction()
      .execute(async trx => uniqueSipUsername(trx, '101'));
    expect(username).toBe('e101-dbbbbb');
  });

  it("keeps a candidate that is only a non-inbound-auth trunk's account name", async () => {
    const db = await makeTestDb();
    await seedTrunk(db, 'e101-daaaaa', false);
    slugs.next = ['aaaaa'];
    const username = await db
      .transaction()
      .execute(async trx => uniqueSipUsername(trx, '101'));
    expect(username).toBe('e101-daaaaa');
  });

  it("regenerates a renamed device's username an inbound-auth trunk holds", async () => {
    const db = await makeTestDb();
    await seedTrunk(db, 'e102-daaaaa', true);
    slugs.next = ['ccccc'];
    const username = await db
      .transaction()
      .execute(async trx =>
        sipUsernameOrFresh(trx, '102', newId(), 'e102-daaaaa')
      );
    expect(username).toBe('e102-dccccc');
  });
});
