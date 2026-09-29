import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { newId, openDb, type Db } from '@zamfono/shared';
import { migrateForTest } from '@zamfono/shared/testDb.js';

import type { AriClient } from './ari/client.js';
import { fakeRtpStatistics } from './ari/fakeRtp.js';
import { AriError, type RtpStatistics } from './ari/types.js';
import type { LogLevel } from './callLog.js';
import { newCall, type Call } from './calls/call.js';
import { QosSnapshots } from './cdrQos.js';
import { eventually } from './testing/eventually.js';

const SAMPLE_MS = 10;

/** What each channel answers to `rtp_statistics`: a body, 404 (`null`), or another failure. */
type Answer = RtpStatistics | null | Error;

function stubAri(answers: Map<string, Answer>): {
  ari: AriClient;
  reads: string[];
} {
  const reads: string[] = [];
  const ari = {
    channels: {
      rtpStatistics: (id: string): Promise<RtpStatistics | null> => {
        reads.push(id);
        const answer = answers.get(id) ?? null;
        return answer instanceof Error
          ? Promise.reject(answer)
          : Promise.resolve(answer);
      }
    }
  } as unknown as AriClient;
  return { ari, reads };
}

async function openCall(db: Db, level: LogLevel = 'qos'): Promise<Call> {
  const call = newCall({
    id: newId(),
    direction: 'inbound',
    callerChannelId: 'caller',
    from: '+4930123456',
    to: '+498912345',
    startedAt: '2026-09-29T10:00:00.000Z',
    logLevel: level,
    callLogMaxBytes: 1_048_576
  });
  await db
    .insertInto('calls')
    .values({
      id: call.id,
      direction: call.direction,
      fromUri: call.from,
      toUri: call.to,
      status: 'interrupted',
      startedAt: call.startedAt
    })
    .execute();
  return call;
}

function answerWith(call: Call, channelId: string): void {
  call.legs.set(channelId, {
    channelId,
    kind: 'device',
    userId: null,
    state: 'up',
    endCause: null
  });
}

describe('QosSnapshots (§7 level qos)', () => {
  // eslint-disable-next-line init-declarations -- assigned in beforeEach before each test runs
  let db: Db;

  beforeEach(async () => {
    db = openDb(':memory:');
    await migrateForTest(db);
  });

  afterEach(async () => {
    await db.destroy();
  });

  async function rowsOf(call: Call): Promise<Record<string, unknown>[]> {
    return db
      .selectFrom('callQos')
      .select(['channelId', 'role', 'jitterMs', 'lossPct', 'rttMs'])
      .where('callId', '=', call.id)
      .orderBy('channelId')
      .execute();
  }

  it('writes one row per up leg, in milliseconds and percent, from real RTPstat fields', async () => {
    const answers = new Map<string, Answer>([
      ['caller', fakeRtpStatistics()],
      ['leg', fakeRtpStatistics({ rtt: 0, rxjitter: 0.0105 })]
    ]);
    const { ari } = stubAri(answers);
    const qos = new QosSnapshots(ari, db, 0);
    const call = await openCall(db);
    answerWith(call, 'leg');

    await qos.write(call);

    expect(await rowsOf(call)).toEqual([
      // 10 of 1000 expected packets missed on receive, 5 of 1000 reported missing by the peer.
      {
        channelId: 'caller',
        role: 'caller',
        jitterMs: 3.4,
        lossPct: 1,
        rttMs: 42
      },
      // No receiver report yet: an unmeasured round trip, not 0 ms.
      {
        channelId: 'leg',
        role: 'callee',
        jitterMs: 10.5,
        lossPct: 1,
        rttMs: null
      }
    ]);
  });

  it('keeps the row of a leg that hung up before the call ended, from its last sample', async () => {
    const answers = new Map<string, Answer>([
      ['caller', fakeRtpStatistics()],
      ['leg', fakeRtpStatistics({ txjitter: 0.02 })]
    ]);
    const { ari, reads } = stubAri(answers);
    const qos = new QosSnapshots(ari, db, SAMPLE_MS);
    const call = await openCall(db);
    answerWith(call, 'leg');
    qos.watch(call);
    await eventually(() => {
      expect(reads).toContain('leg');
    });
    // The callee hangs up: its channel is gone by the time the call's end reads it.
    answers.set('leg', null);

    await qos.write(call);

    expect(await rowsOf(call)).toEqual([
      expect.objectContaining({ channelId: 'caller', role: 'caller' }),
      expect.objectContaining({
        channelId: 'leg',
        role: 'callee',
        jitterMs: 20
      })
    ]);
  });

  it('keeps the caller row of a call that only a mailbox answered once the caller has gone', async () => {
    const answers = new Map<string, Answer>([['caller', fakeRtpStatistics()]]);
    const { ari, reads } = stubAri(answers);
    const qos = new QosSnapshots(ari, db, SAMPLE_MS);
    const call = await openCall(db);
    qos.watch(call);
    await eventually(() => {
      expect(reads).toContain('caller');
    });
    answers.set('caller', null);

    await qos.write(call);

    expect(await rowsOf(call)).toEqual([
      expect.objectContaining({ channelId: 'caller', role: 'caller' })
    ]);
  });

  it('loses no leg to another leg failing to answer', async () => {
    const answers = new Map<string, Answer>([
      ['caller', new AriError(500, 'Internal Server Error')],
      ['leg', fakeRtpStatistics()]
    ]);
    const { ari } = stubAri(answers);
    const qos = new QosSnapshots(ari, db, 0);
    const call = await openCall(db);
    answerWith(call, 'leg');

    await qos.capture(call);
    await qos.write(call);

    expect(await rowsOf(call)).toEqual([
      expect.objectContaining({ channelId: 'leg', role: 'callee' })
    ]);
  });

  it('writes no row for a leg that never carried media', async () => {
    const answers = new Map<string, Answer>([
      [
        'caller',
        fakeRtpStatistics({
          rxcount: 0,
          txcount: 0,
          rxploss: 0,
          txploss: 0,
          rtt: 0
        })
      ]
    ]);
    const { ari } = stubAri(answers);
    const qos = new QosSnapshots(ari, db, 0);
    const call = await openCall(db);

    await qos.write(call);

    expect(await rowsOf(call)).toEqual([]);
  });

  it('samples nothing below level qos, and stops sampling once written', async () => {
    const answers = new Map<string, Answer>([['caller', fakeRtpStatistics()]]);
    const { ari, reads } = stubAri(answers);
    const qos = new QosSnapshots(ari, db, SAMPLE_MS);
    const call = await openCall(db, 'events');
    qos.watch(call);
    await new Promise(resolve => {
      setTimeout(resolve, SAMPLE_MS * 5);
    });
    expect(reads).toEqual([]);

    call.log.raise('qos');
    await eventually(() => {
      expect(reads.length).toBeGreaterThan(0);
    });
    await qos.write(call);
    const readsAtWrite = reads.length;
    await new Promise(resolve => {
      setTimeout(resolve, SAMPLE_MS * 5);
    });
    expect(reads).toHaveLength(readsAtWrite);
  });
});
