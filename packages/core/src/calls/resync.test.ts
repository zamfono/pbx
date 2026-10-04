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

import { newId, nowIso, type Db } from '@zamfono/shared';
import { seedUser } from '@zamfono/shared/testDb.js';

import type { AriClient } from '../ari/client.js';
import type { FakeAri } from '../testing/ari/fake.js';
import { defaultChannel } from '../testing/ari/fakeChannel.js';
import { eventually } from '../testing/eventually.js';
import { noopLogger } from '../testing/pipelineDeps.js';
import { startRig, type Rig } from '../testing/pipelineRig.js';
import { newCall } from './call.js';
import { PARKED_BRIDGE_NAME } from './parkingRingback.js';
import type { Pipeline } from './pipeline.js';
import { resyncOnBoot } from './resync.js';

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

// When the core began connecting; the fake's channels are created after it unless a test says.
const CONNECTING_SINCE = Date.parse('2026-01-01T00:00:00.000Z');
const BEFORE_CONNECTING = '2025-12-31T23:00:00.000+0000';

describe('resyncOnBoot', () => {
  let rig: Rig;
  let db: Db;
  let fakeAri: FakeAri;
  let ari: AriClient;
  let pipeline: Pipeline;

  beforeEach(async () => {
    rig = await startRig();
    ({ db, fakeAri, ari, pipeline } = rig);
  });

  afterEach(async () => {
    await rig.stop();
  });

  function deps(): Parameters<typeof resyncOnBoot>[0] {
    return {
      db,
      ari,
      now: nowIso,
      pipeline,
      log: noopLogger,
      connectingSince: CONNECTING_SINCE
    };
  }

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

  it('marks a pre-existing channel call interrupted', async () => {
    const answered = await seedOpenCall(db, 'answered');
    const placeholder = await seedOpenCall(db, 'interrupted');

    await resyncOnBoot(deps());

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
  });

  it('hangs up a channel in no bridge from before the connection that no call holds, and leaves the others alone', async () => {
    // A party held out of its bridge, a menu caller or a voicemail depositor of the crashed core.
    const orphan = fakeAri.addChannel({
      name: 'PJSIP/e101-a-00000001',
      creationtime: BEFORE_CONNECTING
    });
    // One a call of this process already drives.
    const tracked = fakeAri.addChannel({
      name: 'PJSIP/e102-a-00000002',
      creationtime: BEFORE_CONNECTING
    });
    pipeline.callByChannel.set(
      tracked.id,
      newCall({
        id: newId(),
        direction: 'inbound',
        callerChannelId: tracked.id,
        from: '+15559999',
        to: '102',
        startedAt: nowIso(),
        logLevel: 'events',
        callLogMaxBytes: 1_048_576
      })
    );
    // A call arriving while the resync runs, its `StasisStart` not handled yet.
    const arriving = fakeAri.addChannel({ name: 'PJSIP/e103-a-00000003' });

    await resyncOnBoot(deps());

    expect(hungUp(orphan.id)).toBe(true);
    expect(hungUp(tracked.id)).toBe(false);
    expect(hungUp(arriving.id)).toBe(false);
  });

  it('keeps a two-party bridge up until one party leaves, then hangs up the rest and destroys it', async () => {
    const caller = fakeAri.addChannel({ name: 'PJSIP/trunk-1-00000001' });
    const callee = fakeAri.addChannel({ name: 'PJSIP/e101-a-00000002' });
    const bridge = await ari.bridges.create({ type: 'mixing' });
    await ari.bridges.addChannel(bridge.id, caller.id);
    await ari.bridges.addChannel(bridge.id, callee.id);

    await resyncOnBoot(deps());
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

  it.each(['holding', 'mixing'] as const)(
    'hangs up a parked call alone in its %s bridge, whose parker it no longer knows',
    async type => {
      // `holding` while parked, `mixing` while the parker is rung back.
      const parked = fakeAri.addChannel({ name: 'PJSIP/trunk-1-00000001' });
      const bridge = await ari.bridges.create({
        type,
        name: PARKED_BRIDGE_NAME
      });
      await ari.bridges.addChannel(bridge.id, parked.id);

      await resyncOnBoot(deps());

      expect(hungUp(parked.id)).toBe(true);
      expect(bridgeDestroyed(bridge.id)).toBe(true);
    }
  );

  it('keeps the one who held the other party, alone in the conversation bridge, until they leave', async () => {
    const holder = fakeAri.addChannel({ name: 'PJSIP/e101-a-00000001' });
    const bridge = await ari.bridges.create({ type: 'mixing' });
    await ari.bridges.addChannel(bridge.id, holder.id);

    await resyncOnBoot(deps());
    expect(hungUp(holder.id)).toBe(false);

    fakeAri.emit({
      type: 'ChannelDestroyed',
      timestamp: nowIso(),
      application: 'zamfono',
      channel: defaultChannel({ id: holder.id }),
      cause: 16
    });
    await eventually(() => {
      expect(bridgeDestroyed(bridge.id)).toBe(true);
    });
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

    pipeline.deps.mediaDir = mediaDir;
    await resyncOnBoot(deps());

    const remaining = await readdir(dir);
    expect(remaining.sort()).toEqual(['kept.wav', 'notes.txt']);
  });
});
