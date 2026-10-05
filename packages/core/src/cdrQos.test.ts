import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { newId, type CallLogLevel, type Db } from '@zamfono/shared';
import { migratedTestDb } from '@zamfono/shared/testDb.js';

import type { Channel } from './ari/types.js';
import { newCall, type Call } from './calls/call.js';
import { QosRows } from './cdrQos.js';
import { RtcpQos } from './rtcpQos.js';
import { parseRtcpReport, type RtcpHepReport } from './rtcpReport.js';
import { defaultChannel } from './testing/ari/fakeChannel.js';
import { fakeRtpAudioQos } from './testing/ari/fakeRtp.js';
import { noopLogger } from './testing/pipelineDeps.js';
import { fixedPoint, ntpMiddle, rtcpPayload } from './testing/rtcpPayload.js';

/** `id`'s `ChannelDestroyed` channel, carrying `rtpAudioQos` as its `RTPAUDIOQOS`. */
function ended(id: string, rtpAudioQos = fakeRtpAudioQos()): Channel {
  return defaultChannel({ id, channelvars: { RTPAUDIOQOS: rtpAudioQos } });
}

async function openCall(
  db: Db,
  level: CallLogLevel = 'qos',
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
    id: channelId,
    channelId,
    kind: 'device',
    userId: null,
    state: 'up',
    endCause: null
  });
}

const T0 = 1_790_000_000_000;

/** The RTCP reports of a leg whose phone answers Asterisk's sender report of 1000 packets 80 ms
 * later on the wire, missing 30 of them (3 %). */
function rtcpOfLeg(sipCallId: string): RtcpHepReport[] {
  const reports: [RtcpHepReport['sender'], number, string][] = [
    ['asterisk', T0, rtcpPayload({ ssrc: 7, sent: 1000, atMs: T0 })],
    [
      'peer',
      T0 + 330,
      rtcpPayload({
        ssrc: 8,
        blocks: [
          {
            sourceSsrc: 7,
            packetsLost: 30,
            lsr: ntpMiddle(T0),
            dlsr: fixedPoint(0.25)
          }
        ]
      })
    ]
  ];
  return reports.map(([sender, atMs, payload]) => {
    const report = parseRtcpReport(payload);
    if (report === null) {
      throw new Error('not a report');
    }
    return { callId: sipCallId, atMs, sender, report };
  });
}

describe('QosRows (§7 level qos)', () => {
  let db: Db;

  beforeEach(async () => {
    db = await migratedTestDb();
  });

  afterEach(async () => {
    await db.destroy();
  });

  async function rowsOf(call: Call): Promise<Record<string, unknown>[]> {
    return db
      .selectFrom('callQos')
      .select([
        'channelId',
        'role',
        'jitterMs',
        'lossPct',
        'rttMs',
        'rxPackets',
        'txPackets'
      ])
      .where('callId', '=', call.id)
      .orderBy('channelId')
      .execute();
  }

  it('writes one row per up leg, in milliseconds and percent, from what each hangup left', async () => {
    const qos = new QosRows(db, holding([]), noopLogger);
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
        rttMs: 42,
        rxPackets: 990,
        txPackets: 1000
      },
      // No receiver report yet: an unmeasured round trip, not 0 ms.
      {
        channelId: 'leg',
        role: 'callee',
        jitterMs: 10.5,
        lossPct: 1,
        rttMs: null,
        rxPackets: 990,
        txPackets: 1000
      }
    ]);
  });

  it('reads the exact variable Asterisk 22 sets, fields it does not read included', async () => {
    const qos = new QosRows(db, holding([]), noopLogger);
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
        rttMs: null,
        rxPackets: 351,
        txPackets: 351
      }
    ]);
  });

  it('keeps the row of a leg that hung up and left the call before it ended', async () => {
    const qos = new QosRows(db, holding([]), noopLogger);
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
    const qos = new QosRows(db, holding([]), noopLogger);
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
    const qos = new QosRows(db, holding([]), noopLogger);
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

  it('writes a row of nothing measured but its packet counts of 0 for a leg that carried no media', async () => {
    const qos = new QosRows(db, holding([]), noopLogger);
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

    // Figures of 0 would read as a perfect line; the counts of 0 are the finding: no audio.
    expect(await rowsOf(call)).toEqual([
      {
        channelId: 'caller',
        role: 'caller',
        jitterMs: null,
        lossPct: null,
        rttMs: null,
        rxPackets: 0,
        txPackets: 0
      }
    ]);
  });

  it('writes no loss for a one-way-audio leg whose peer never sent a receiver report', async () => {
    const qos = new QosRows(db, holding([]), noopLogger);
    const call = await openCall(db);
    qos.note(call);

    // Packets went out but none came back, RTCP included: Asterisk leaves `rlp` at 0, which is
    // no measurement of the sent direction, not a lossless one.
    await qos.channelEnded(
      ended(
        'caller',
        'lp=1;rxjitter=0;rxcount=0;txjitter=0;txcount=1500;rlp=0;rtt=0'
      )
    );
    await qos.write(call);

    // Nothing reached this side of the leg: no packet received, 1500 sent.
    expect(await rowsOf(call)).toEqual([
      {
        channelId: 'caller',
        role: 'caller',
        jitterMs: null,
        lossPct: null,
        rttMs: null,
        rxPackets: 0,
        txPackets: 1500
      }
    ]);
  });

  it('writes no packet count RTPAUDIOQOS does not name, rather than 0', async () => {
    const qos = new QosRows(db, holding([]), noopLogger);
    const call = await openCall(db);
    qos.note(call);

    await qos.channelEnded(
      ended('caller', 'lp=0;rxjitter=0.001;txjitter=0.001;rlp=0;rtt=0.02')
    );
    await qos.write(call);

    expect(await rowsOf(call)).toEqual([
      expect.objectContaining({ rxPackets: null, txPackets: null })
    ]);
  });

  it('writes nothing below level qos, before or after the write, unless routing raised it', async () => {
    const qos = new QosRows(db, holding([]), noopLogger);
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
    const channels = holding(['caller']);
    const listed = vi.spyOn(channels, 'list');
    const qos = new QosRows(db, channels, noopLogger, 20);
    const call = await openCall(db);
    qos.note(call);
    answerWith(call, 'leg');
    await qos.write(call);

    await vi.waitFor(() => {
      expect(listed).toHaveBeenCalled();
    });
    // The leg's `ChannelDestroyed`, arriving after it was let go, gives no row; the caller lives on
    // (a transferred caller in the call it was handed to) and still has its row.
    await qos.channelEnded(ended('leg'));
    await qos.channelEnded(ended('caller'));
    expect(await rowsOf(call)).toEqual([
      expect.objectContaining({ channelId: 'caller', role: 'caller' })
    ]);
  });

  it('lets go of every awaited channel Asterisk no longer holds as ARI reconnects, of a call not written yet too', async () => {
    const live = ['caller'];
    const qos = new QosRows(db, holding(live), noopLogger);
    const call = await openCall(db);
    const other = await openCall(db, 'qos', 'caller-2');
    qos.note(call);
    answerWith(call, 'leg');
    qos.note(call);
    qos.note(other);

    await qos.resync();

    // The gone channels were let go for good: noted again, they are not awaited a second time,
    // and their late `ChannelDestroyed`s give no row; the caller Asterisk still holds keeps its.
    qos.note(other);
    await qos.write(call);
    await qos.write(other);
    await qos.channelEnded(ended('leg'));
    await qos.channelEnded(ended('caller-2'));
    await qos.channelEnded(ended('caller'));
    expect(await rowsOf(call)).toEqual([
      expect.objectContaining({ channelId: 'caller', role: 'caller' })
    ]);
    expect(await rowsOf(other)).toEqual([]);
  });

  it('fills from the leg’s RTCP reports what RTPAUDIOQOS left unmeasured, and keeps what it measured', async () => {
    const rtcp = new RtcpQos();
    const qos = new QosRows(db, holding([]), noopLogger, undefined, rtcp);
    const call = await openCall(db);
    qos.note(call);
    rtcp.join('caller', 'caller-call-id');
    for (const report of rtcpOfLeg('caller-call-id')) {
      rtcp.report(report);
    }

    // Asterisk measured jitter and loss but no round trip (0), and counted 1200 packets sent to
    // the reports' 1000, which were as of its last sender report.
    await qos.channelEnded(
      ended('caller', fakeRtpAudioQos({ rtt: 0, txcount: 1200 }))
    );
    await qos.write(call);

    const [row] = await rowsOf(call);
    expect(row).toMatchObject({
      jitterMs: 3.4,
      lossPct: 1,
      rxPackets: 990,
      txPackets: 1200
    });
    expect(row?.rttMs).toBeCloseTo(80, 1);
  });

  it('keeps a packet count of 0 RTPAUDIOQOS measured over the RTCP reports’ count', async () => {
    const rtcp = new RtcpQos();
    const qos = new QosRows(db, holding([]), noopLogger, undefined, rtcp);
    const call = await openCall(db);
    qos.note(call);
    rtcp.join('caller', 'caller-call-id');
    for (const report of rtcpOfLeg('caller-call-id')) {
      rtcp.report(report);
    }

    await qos.channelEnded(
      ended('caller', fakeRtpAudioQos({ rxcount: 0, txcount: 0 }))
    );
    await qos.write(call);

    const [row] = await rowsOf(call);
    expect(row).toMatchObject({ rxPackets: 0, txPackets: 0 });
  });

  it('writes the row of a leg whose ChannelDestroyed was lost from its RTCP reports', async () => {
    const rtcp = new RtcpQos();
    const qos = new QosRows(db, holding([]), noopLogger, undefined, rtcp);
    const call = await openCall(db);
    qos.note(call);
    rtcp.join('caller', 'caller-call-id');
    for (const report of rtcpOfLeg('caller-call-id')) {
      rtcp.report(report);
    }
    await qos.write(call);

    await qos.resync();

    const [row] = await rowsOf(call);
    // The sent count is Asterisk's own sender report's; what reached Asterisk no report counts.
    expect(row).toMatchObject({
      channelId: 'caller',
      jitterMs: null,
      lossPct: 3,
      rxPackets: null,
      txPackets: 1000
    });
    expect(row?.rttMs).toBeCloseTo(80, 1);
    expect(rtcp.joined()).toEqual([]);
  });
});
