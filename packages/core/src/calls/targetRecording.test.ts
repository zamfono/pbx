import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DEFAULT_SIP_HEADERS, nowIso, type Db } from '@zamfono/shared';
import { seedDid, seedUser } from '@zamfono/shared/testDb.js';

import type { FakeAri } from '../testing/ari/fake.js';
import { eventually } from '../testing/eventually.js';
import { noopLogger } from '../testing/pipelineDeps.js';
import { startRig, type Rig } from '../testing/pipelineRig.js';
import {
  seedDevice,
  seedExternalRoute,
  seedForwardTarget,
  seedRingGroup,
  seedTrunk
} from '../testing/seedRows.js';
import type { Call } from './call.js';
import { Recorder } from './recording.js';

// §10.2 "Recording semantics": an `external` or `sip` forward target with `record_calls` set
// records the trunk leg it answers on, however the call reached it, as nobody's participation
// unless it already is a user's (an `unconditional` forward's), and then as that one recording.

const DID = '+15551000';
const FORWARD_NUMBER = '+15557777';

describe('a forward target that records (§10.2 "Recording semantics")', () => {
  let rig: Rig;
  let db: Db;
  let fakeAri: FakeAri;

  beforeEach(async () => {
    rig = await startRig();
    ({ db, fakeAri } = rig);
    fakeAri.answerAfterMs = 10;
    await db
      .updateTable('settings')
      .set({ mainDidId: await seedDid(db, '+15550000') })
      .execute();
    rig.pipeline.deps.recorder = new Recorder({
      ari: rig.ari,
      cache: rig.cache,
      db,
      mediaDir: '/media',
      mix: () => Promise.resolve(5),
      log: noopLogger,
      now: nowIso
    });
  });

  afterEach(async () => {
    await rig.stop();
  });

  /** A `sip` target over an `ip` trunk with one outbound host, recording when `record` is 1. */
  async function sipTarget(record: 0 | 1): Promise<string> {
    const trunkId = await seedTrunk(db, { authMode: 'ip', transport: 'tls' }, [
      'sip.api.openai.com'
    ]);
    return seedForwardTarget(db, {
      sipTrunkId: trunkId,
      sipUser: 'proj_abc123',
      sipHeadersJson: JSON.stringify(DEFAULT_SIP_HEADERS),
      recordCalls: record
    });
  }

  /** An inbound call from `from` to `DID`, as Asterisk hands it to the core, once answered. */
  function callIn(from: string): Promise<Call> {
    const caller = fakeAri.addChannel({
      name: 'PJSIP/trunk-1-00000001',
      caller: { number: from, name: '' }
    });
    fakeAri.emit({
      type: 'StasisStart',
      timestamp: nowIso(),
      application: 'zamfono',
      args: ['inbound', DID],
      channel: caller
    });
    return eventually(() => {
      const call = rig.pipeline.callByChannel.get(caller.id);
      if (call?.status !== 'answered') {
        throw new Error('the call to the target is not answered yet');
      }
      return call;
    });
  }

  function recordRequests(): typeof fakeAri.calls {
    return fakeAri.calls.filter(
      entry => entry.method === 'POST' && entry.path.endsWith('/record')
    );
  }

  /** Hangs up `calls`' answered trunk legs and finishes their snoop recordings as Asterisk does
   * once each snoop is hung up; the `recordings` rows, once each recorded leg has its own. */
  async function hangUpAndStore(
    calls: Call[],
    recorded: number
  ): Promise<{ callId: string; userId: string | null }[]> {
    await eventually(() => {
      expect(recordRequests()).toHaveLength(recorded * 2);
    });
    for (const call of calls) {
      const leg = [...call.legs.values()].find(each => each.state === 'up');
      fakeAri.hangUpRemotely(leg?.channelId ?? '');
    }
    const snoopHungUp = (entry: (typeof fakeAri.calls)[number]): boolean =>
      rig.hungUp(entry.path.slice('channels/'.length, -'/record'.length));
    const records = await eventually(() => {
      const all = recordRequests();
      expect(all.every(snoopHungUp)).toBe(true);
      return all;
    });
    for (const entry of records) {
      fakeAri.emit({
        type: 'RecordingFinished',
        timestamp: nowIso(),
        application: 'zamfono',
        recording: { name: (entry.body as { name?: string }).name }
      });
    }
    return eventually(async () => {
      const rows = await db
        .selectFrom('recordings')
        .select(['callId', 'userId'])
        .execute();
      expect(rows).toHaveLength(recorded);
      return rows;
    });
  }

  it("records a DID's own sip target as nobody's participation", async () => {
    await seedDid(db, DID, await sipTarget(1));
    rig.cache.invalidate();

    const call = await callIn('+15559999');

    expect(await hangUpAndStore([call], 1)).toEqual([
      { callId: call.id, userId: null }
    ]);
  });

  it('records each of two concurrent calls to the target once', async () => {
    await seedDid(db, DID, await sipTarget(1));
    rig.cache.invalidate();

    const first = await callIn('+15559991');
    const second = await callIn('+15559992');

    const rows = await hangUpAndStore([first, second], 2);
    expect(rows).toEqual(
      expect.arrayContaining([
        { callId: first.id, userId: null },
        { callId: second.id, userId: null }
      ])
    );
  });

  it("records the external target of a ring group's unavailable rule", async () => {
    await seedExternalRoute(db);
    const groupId = await seedRingGroup(db, { ringTimeoutS: 1 });
    // A member whose one phone is not registered: nobody is ringable.
    const member = await seedUser(db, { name: 'Bea', mailboxEnabled: 0 });
    await seedDevice(db, member, 'e177-d1');
    await db
      .insertInto('ringGroupMembers')
      .values({ groupId, position: 0, userId: member })
      .execute();
    await db
      .insertInto('ringGroupForwardRules')
      .values({
        groupId,
        condition: 'unavailable',
        targetId: await seedForwardTarget(db, {
          external: FORWARD_NUMBER,
          recordCalls: 1
        })
      })
      .execute();
    await seedDid(
      db,
      DID,
      await seedForwardTarget(db, { ringGroupId: groupId })
    );
    rig.cache.invalidate();

    const call = await callIn('+15559999');

    expect(await hangUpAndStore([call], 1)).toEqual([
      { callId: call.id, userId: null }
    ]);
  });

  it('records nothing for a target whose flag is off', async () => {
    await seedDid(db, DID, await sipTarget(0));
    rig.cache.invalidate();

    await callIn('+15559999');
    await rig.pipeline.idle();

    expect(recordRequests()).toEqual([]);
  });

  it("records a flagged user's unconditional forward to it once, as the user's", async () => {
    const userId = await seedUser(db, {
      name: 'Bea',
      mailboxEnabled: 0,
      recordCalls: 1
    });
    await db
      .insertInto('userForwardRules')
      .values({
        userId,
        condition: 'unconditional',
        targetId: await sipTarget(1)
      })
      .execute();
    await seedDid(db, DID, await seedForwardTarget(db, { userId }));
    rig.cache.invalidate();

    const call = await callIn('+15559999');

    expect(await hangUpAndStore([call], 1)).toEqual([
      { callId: call.id, userId }
    ]);
  });
});
