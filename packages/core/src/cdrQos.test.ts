import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { newId, openDb, type Db } from '@zamfono/shared';
import { migrateForTest } from '@zamfono/shared/testDb.js';

import { fakeRtpAudioQos } from './ari/fakeRtp.js';
import { defaultChannel, type Channel } from './ari/types.js';
import type { LogLevel } from './callLog.js';
import { newCall, type Call } from './calls/call.js';
import { QosRows } from './cdrQos.js';

/** `id`'s `ChannelDestroyed` channel, carrying `rtpAudioQos` as its `RTPAUDIOQOS`. */
function ended(id: string, rtpAudioQos = fakeRtpAudioQos()): Channel {
  return defaultChannel({ id, channelvars: { RTPAUDIOQOS: rtpAudioQos } });
}

async function openCall(
  db: Db,
  level: LogLevel = 'qos',
  callerChannelId = 'caller'
): Promise<Call> {
  const call = newCall({
    id: newId(),
    direction: 'inbound',
    callerChannelId,
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

/** Asterisk's channel list, holding the channels `ids` names (mutable, for a test to change). */
function holding(ids: string[]): { list: () => Promise<Channel[]> } {
  return {
    list: () => Promise.resolve(ids.map(id => defaultChannel({ id })))
  };
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

describe('QosRows (§7 level qos)', () => {
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

  it('writes one row per up leg, in milliseconds and percent, from what each hangup left', async () => {
    const qos = new QosRows(db, holding([]));
    const call = await openCall(db);
    qos.note(call);
    answerWith(call, 'leg');
    qos.note(call);

    await qos.channelEnded(ended('caller'));
    await qos.channelEnded(
      ended('leg', fakeRtpAudioQos({ rtt: 0, rxjitter: 0.0105 }))
    );
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

  it('reads the exact variable Asterisk 22 sets, fields it does not read included', async () => {
    const qos = new QosRows(db, holding([]));
    const call = await openCall(db);
    qos.note(call);

    // As `ast_rtp_instance_get_quality` wrote it for a leg on a test stack, 351 packets each way.
    await qos.channelEnded(
      ended(
        'caller',
        'ssrc=784882500;themssrc=1867692567;lp=0;rxjitter=0.000250;rxcount=351;' +
          'txjitter=0.000250;txcount=351;rlp=0;rtt=0.000000;rxmes=88.087887;txmes=88.087887'
      )
    );
    await qos.write(call);

    expect(await rowsOf(call)).toEqual([
      {
        channelId: 'caller',
        role: 'caller',
        jitterMs: 0.25,
        lossPct: 0,
        rttMs: null
      }
    ]);
  });

  it('keeps the row of a leg that hung up and left the call before it ended', async () => {
    const qos = new QosRows(db, holding([]));
    const call = await openCall(db);
    answerWith(call, 'leg');
    qos.note(call);
    // The callee hangs up first; its leg is no longer up when the call ends.
    await qos.channelEnded(ended('leg', fakeRtpAudioQos({ txjitter: 0.02 })));
    call.legs.delete('leg');

    await qos.write(call);
    await qos.channelEnded(ended('caller'));

    expect(await rowsOf(call)).toEqual([
      expect.objectContaining({ channelId: 'caller', role: 'caller' }),
      expect.objectContaining({
        channelId: 'leg',
        role: 'callee',
        jitterMs: 20
      })
    ]);
  });

  it('writes the row of a leg hung up after the call was written, as it goes', async () => {
    const qos = new QosRows(db, holding([]));
    const call = await openCall(db);
    qos.note(call);
    answerWith(call, 'leg');

    await qos.write(call);
    expect(await rowsOf(call)).toEqual([]);
    await qos.channelEnded(ended('leg'));

    expect(await rowsOf(call)).toEqual([
      expect.objectContaining({ channelId: 'leg', role: 'callee' })
    ]);
  });

  it('writes no row for a channel without an RTP instance, nor twice for one', async () => {
    const qos = new QosRows(db, holding([]));
    const call = await openCall(db);
    answerWith(call, 'local');
    qos.note(call);

    // A Local channel: Asterisk leaves the variable unset, which ARI reports as "".
    await qos.channelEnded(ended('local', ''));
    await qos.channelEnded(ended('caller'));
    // Noted again after its channel went (the call's last events), the caller keeps one row.
    qos.note(call);
    await qos.write(call);
    await qos.channelEnded(ended('caller'));

    expect(await rowsOf(call)).toEqual([
      expect.objectContaining({ channelId: 'caller', role: 'caller' })
    ]);
  });

  it('writes a row of nothing measured for a leg that carried no media, not zeros', async () => {
    const qos = new QosRows(db, holding([]));
    const call = await openCall(db);
    qos.note(call);

    // What Asterisk 22 sets on a leg no RTP packet reached: every count 0, and one packet
    // "missed" out of none received.
    await qos.channelEnded(
      ended(
        'caller',
        fakeRtpAudioQos({
          rxcount: 0,
          txcount: 0,
          rxploss: 1,
          txploss: 0,
          rxjitter: 0,
          txjitter: 0,
          rtt: 0
        })
      )
    );
    await qos.write(call);

    expect(await rowsOf(call)).toEqual([
      {
        channelId: 'caller',
        role: 'caller',
        jitterMs: null,
        lossPct: null,
        rttMs: null
      }
    ]);
  });

  it('writes nothing below level qos, before or after the write, unless routing raised it', async () => {
    const qos = new QosRows(db, holding([]));
    const low = await openCall(db, 'events');
    qos.note(low);
    answerWith(low, 'leg');
    await qos.channelEnded(ended('caller'));
    await qos.write(low);
    await qos.channelEnded(ended('leg'));
    expect(await rowsOf(low)).toEqual([]);

    const raised = await openCall(db, 'events', 'caller-2');
    qos.note(raised);
    await qos.channelEnded(ended('caller-2'));
    raised.log.raise('qos');
    await qos.write(raised);
    expect(await rowsOf(raised)).toEqual([
      expect.objectContaining({ channelId: 'caller-2', role: 'caller' })
    ]);
  });

  // A `ChannelDestroyed` lost while the ARI connection was down never arrives.
  it('lets go of a written call’s channel Asterisk no longer holds once the tail has passed, and keeps one that lives on', async () => {
    const live = ['caller'];
    const qos = new QosRows(db, holding(live), 20);
    const call = await openCall(db);
    qos.note(call);
    answerWith(call, 'leg');
    await qos.write(call);
    expect(qos.awaited).toBe(2);

    await vi.waitFor(() => {
      expect(qos.awaited).toBe(1);
    });
    // The caller lives on (a transferred caller in the call it was handed to) and still has its row.
    await qos.channelEnded(ended('caller'));
    expect(qos.awaited).toBe(0);
    expect(await rowsOf(call)).toEqual([
      expect.objectContaining({ channelId: 'caller', role: 'caller' })
    ]);
  });

  it('lets go of every awaited channel Asterisk no longer holds as ARI reconnects, of a call not written yet too', async () => {
    const live = ['caller'];
    const qos = new QosRows(db, holding(live));
    const call = await openCall(db);
    const other = await openCall(db, 'qos', 'caller-2');
    qos.note(call);
    answerWith(call, 'leg');
    qos.note(call);
    qos.note(other);
    expect(qos.awaited).toBe(3);

    await qos.resync();

    expect(qos.awaited).toBe(1);
    // The gone channel was let go for good: noted again, it is not awaited a second time.
    qos.note(other);
    expect(qos.awaited).toBe(1);
    await qos.write(other);
    expect(await rowsOf(other)).toEqual([]);
  });
});
