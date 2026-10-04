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

import type { AriClient } from '../ari/client.js';
import type { FakeAri } from '../testing/ari/fake.js';
import { defaultChannel } from '../testing/ari/fakeChannel.js';
import { eventually } from '../testing/eventually.js';
import { noopLogger } from '../testing/pipelineDeps.js';
import { startRig, type Rig } from '../testing/pipelineRig.js';
import { seedUser } from '../testing/seedRows.js';
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
      pipeline,
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
      pipeline,
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

      await resyncOnBoot({
        db,
        ari,
        now: nowIso,
        pipeline,
        log: noopLogger
      });

      expect(hungUp(parked.id)).toBe(true);
      expect(bridgeDestroyed(bridge.id)).toBe(true);
    }
  );

  it('keeps the one who held the other party, alone in the conversation bridge, until they leave', async () => {
    const holder = fakeAri.addChannel({ name: 'PJSIP/e101-a-00000001' });
    const bridge = await ari.bridges.create({ type: 'mixing' });
    await ari.bridges.addChannel(bridge.id, holder.id);

    await resyncOnBoot({
      db,
      ari,
      now: nowIso,
      pipeline,
      log: noopLogger
    });
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
    await resyncOnBoot({
      db,
      ari,
      now: nowIso,
      pipeline,
      log: noopLogger
    });

    const remaining = await readdir(dir);
    expect(remaining.sort()).toEqual(['kept.wav', 'notes.txt']);
  });
});
