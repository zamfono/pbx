import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  onTestFinished
} from 'vitest';

import { newId, nowIso, openDb, type Db } from '@zamfono/shared';
import { migrateForTest } from '@zamfono/shared/testDb.js';

import { AriClient } from '../ari/client.js';
import { FakeAri } from '../ari/fake.js';
import { defaultChannel } from '../ari/fakeChannel.js';
import { eventually } from '../testing/eventually.js';
import { noopLogger, testPipelineDeps } from '../testing/pipelineDeps.js';
import { Pipeline } from './pipeline.js';
import { resyncOnBoot } from './resync.js';

async function seedUser(db: Db): Promise<string> {
  const id = newId();
  await db
    .insertInto('users')
    .values({
      id,
      name: 'User',
      email: `${id}@example.com`,
      createdAt: nowIso()
    })
    .execute();
  return id;
}

/** A `calls` row still open, the way `CdrWriter.open` leaves one while its call is live. */
async function seedOpenCall(
  db: Db,
  status: 'answered' | 'interrupted'
): Promise<string> {
  const id = newId();
  await db
    .insertInto('calls')
    .values({
      id,
      direction: 'inbound',
      fromUri: '+15559999',
      toUri: '+15551234',
      status,
      startedAt: nowIso(),
      answeredAt: null,
      endedAt: null,
      log: null
    })
    .execute();
  return id;
}

describe('resyncOnBoot', () => {
  let db: Db;
  let fakeAri: FakeAri;
  let ari: AriClient;

  beforeEach(async () => {
    db = openDb(':memory:');
    await migrateForTest(db);
    fakeAri = new FakeAri();
    const { url } = await fakeAri.listen();
    ari = new AriClient({
      url,
      user: 'zamfono',
      password: 'secret',
      app: 'zamfono',
      log: noopLogger
    });
    await ari.connect();
  });

  afterEach(async () => {
    await ari.close();
    await fakeAri.close();
    await db.destroy();
  });

  function hungUp(channelId: string): boolean {
    return fakeAri.calls.some(
      entry =>
        entry.method === 'DELETE' && entry.path === `channels/${channelId}`
    );
  }

  function bridgeDestroyed(bridgeId: string): boolean {
    return fakeAri.calls.some(
      entry => entry.method === 'DELETE' && entry.path === `bridges/${bridgeId}`
    );
  }

  it('marks a pre-existing channel call interrupted and leaves a channel in no bridge alone', async () => {
    const answered = await seedOpenCall(db, 'answered');
    const placeholder = await seedOpenCall(db, 'interrupted');
    const unbridged = fakeAri.addChannel({ name: 'PJSIP/e101-a-00000001' });

    await resyncOnBoot({
      db,
      ari,
      now: nowIso,
      pipeline: new Pipeline(testPipelineDeps(ari, db)),
      log: noopLogger
    });

    const rows = await db
      .selectFrom('calls')
      .select(['id', 'status', 'endedAt'])
      .where('id', 'in', [answered, placeholder])
      .execute();
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.status).toBe('interrupted');
      expect(row.endedAt).not.toBeNull();
    }
    // §10.1 lists no cleanup for it: a call arriving while the resync runs is not hung up.
    expect(hungUp(unbridged.id)).toBe(false);
  });

  it('keeps a two-party bridge up until one party leaves, then hangs up the rest and destroys it', async () => {
    const caller = fakeAri.addChannel({ name: 'PJSIP/trunk-1-00000001' });
    const callee = fakeAri.addChannel({ name: 'PJSIP/e101-a-00000002' });
    const bridge = await ari.bridges.create({ type: 'mixing' });
    await ari.bridges.addChannel(bridge.id, caller.id);
    await ari.bridges.addChannel(bridge.id, callee.id);

    await resyncOnBoot({
      db,
      ari,
      now: nowIso,
      pipeline: new Pipeline(testPipelineDeps(ari, db)),
      log: noopLogger
    });
    expect(hungUp(caller.id)).toBe(false);
    expect(hungUp(callee.id)).toBe(false);
    expect(bridgeDestroyed(bridge.id)).toBe(false);

    fakeAri.emit({
      type: 'ChannelDestroyed',
      timestamp: nowIso(),
      application: 'zamfono',
      channel: defaultChannel({ id: caller.id }),
      cause: 16
    });
    await eventually(() => {
      expect(hungUp(callee.id)).toBe(true);
      expect(bridgeDestroyed(bridge.id)).toBe(true);
    });
  });

  it('hangs up a parked call, a channel alone in its bridge, whose parker it no longer knows', async () => {
    const parked = fakeAri.addChannel({ name: 'PJSIP/trunk-1-00000001' });
    const holding = await ari.bridges.create({ type: 'holding' });
    await ari.bridges.addChannel(holding.id, parked.id);

    await resyncOnBoot({
      db,
      ari,
      now: nowIso,
      pipeline: new Pipeline(testPipelineDeps(ari, db)),
      log: noopLogger
    });

    expect(hungUp(parked.id)).toBe(true);
    expect(bridgeDestroyed(holding.id)).toBe(true);
  });

  it('deletes voicemail files without a voicemails row and keeps the others', async () => {
    const userId = await seedUser(db);
    const mediaDir = await mkdtemp(path.join(os.tmpdir(), 'zamfono-media-'));
    onTestFinished(() => rm(mediaDir, { recursive: true, force: true }));
    const dir = path.join(mediaDir, 'voicemail');
    await mkdir(dir);
    await writeFile(path.join(dir, 'kept.wav'), 'RIFF');
    await writeFile(path.join(dir, 'orphan.wav'), 'RIFF');
    await writeFile(path.join(dir, 'notes.txt'), 'x');
    await db
      .insertInto('voicemails')
      .values({
        id: newId(),
        mailboxUserId: userId,
        mailboxRingGroupId: null,
        caller: '+15559999',
        filename: 'kept.wav',
        durationS: 3,
        createdAt: nowIso(),
        read: 0
      })
      .execute();

    await resyncOnBoot({
      db,
      ari,
      now: nowIso,
      pipeline: new Pipeline(testPipelineDeps(ari, db, { mediaDir })),
      log: noopLogger
    });

    const remaining = await readdir(dir);
    expect(remaining.sort()).toEqual(['kept.wav', 'notes.txt']);
  });
});
