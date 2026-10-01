import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { newId, nowIso, openDb, type Db, type Envelope } from '@zamfono/shared';
import { migrateForTest } from '@zamfono/shared/testDb.js';

import { AriClient } from './ari/client.js';
import { FakeAri } from './ari/fake.js';
import { fakeRtpAudioQos } from './ari/fakeRtp.js';
import { defaultChannel, type Channel, type Logger } from './ari/types.js';
import type { LogLevel } from './callLog.js';
import { newCall, type Call } from './calls/call.js';
import { CdrWriter } from './cdr.js';
import { EventBus } from './internal/eventBus.js';
import { ConfigCache } from './internal/snapshot.js';
import { StateStore } from './internal/stateStore.js';
import { parseRtcpReport } from './rtcpReport.js';
import { fixedPoint, ntpMiddle, rtcpPayload } from './testing/rtcpPayload.js';

const noopLogger: Logger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined
};

const NOW = '2026-01-01T00:05:00.000Z';

/** `id`'s `ChannelDestroyed` channel, carrying the `RTPAUDIOQOS` Asterisk set as it hung up. */
function endedChannel(id: string, rtpAudioQos = fakeRtpAudioQos()): Channel {
  return defaultChannel({ id, channelvars: { RTPAUDIOQOS: rtpAudioQos } });
}

async function seedForwardTargetUser(db: Db, userId: string): Promise<string> {
  const id = newId();
  await db.insertInto('forwardTargets').values({ id, userId }).execute();
  return id;
}

async function seedUser(db: Db): Promise<string> {
  const id = newId();
  await db
    .insertInto('users')
    .values({
      id,
      name: 'Test User',
      email: `${id}@example.com`,
      createdAt: nowIso()
    })
    .execute();
  return id;
}

async function seedDid(db: Db, targetId: string): Promise<string> {
  const id = newId();
  await db
    .insertInto('dids')
    .values({ id, number: '+15551000', targetId, createdAt: nowIso() })
    .execute();
  return id;
}

/** Settings plus the DID it references, at the given call-log level (§7). */
async function seedSettings(db: Db, callLogLevel: string): Promise<void> {
  const userId = await seedUser(db);
  const targetId = await seedForwardTargetUser(db, userId);
  const didId = await seedDid(db, targetId);
  await db
    .insertInto('settings')
    .values({
      id: 1,
      companyName: 'Zamfono',
      mainDidId: didId,
      country: 'DE',
      emergencyNumbersJson: '["112"]',
      callLogLevel
    })
    .execute();
}

function waitFor(done: () => boolean, timeoutMs = 2000): Promise<void> {
  const POLL_MS = 5;
  const deadline = Date.now() + timeoutMs;
  return new Promise<void>(resolve => {
    const tick = (): void => {
      if (done() || Date.now() > deadline) {
        resolve();
        return;
      }
      setTimeout(tick, POLL_MS).unref();
    };
    tick();
  });
}

// A driver may run a statement any number of ticks after `execute()` returns (Kysely's SQLite one
// does, several microtasks later); this one holds every `calls` insert back a whole timer tick, so
// a caller that does not wait for the insert sees no row.
const SLOW_INSERT_MS = 20;

function withSlowCallsInsert(db: Db): Db {
  const slow = (builder: object): object =>
    new Proxy(builder, {
      get(target, prop, receiver): unknown {
        const value: unknown = Reflect.get(target, prop, receiver);
        if (prop === 'execute' && typeof value === 'function') {
          return async (): Promise<unknown> => {
            await new Promise(resolve => {
              setTimeout(resolve, SLOW_INSERT_MS);
            });
            return (value as () => Promise<unknown>).call(target);
          };
        }
        if (prop === 'values' && typeof value === 'function') {
          return (...args: unknown[]): object =>
            slow((value as (...rest: unknown[]) => object).apply(target, args));
        }
        return value;
      }
    });
  return new Proxy(db, {
    get(target, prop, receiver): unknown {
      if (prop !== 'insertInto') {
        return Reflect.get(target, prop, receiver);
      }
      return (table: Parameters<Db['insertInto']>[0]) =>
        table === 'calls'
          ? slow(target.insertInto(table))
          : target.insertInto(table);
    }
  });
}

function buildCall(logLevel: LogLevel = 'events'): Call {
  return newCall({
    id: newId(),
    direction: 'inbound',
    callerChannelId: 'caller-channel',
    from: '+15559999',
    to: '+15551000',
    startedAt: '2026-01-01T00:00:00.000Z',
    logLevel,
    callLogMaxBytes: 1_048_576
  });
}

describe('CdrWriter', () => {
  // eslint-disable-next-line init-declarations -- assigned in beforeEach before each test runs
  let db: Db;
  // eslint-disable-next-line init-declarations -- assigned in beforeEach before each test runs
  let fakeAri: FakeAri;
  // eslint-disable-next-line init-declarations -- assigned in beforeEach before each test runs
  let ari: AriClient;
  // eslint-disable-next-line init-declarations -- assigned in beforeEach before each test runs
  let bus: EventBus;
  // eslint-disable-next-line init-declarations -- assigned in beforeEach before each test runs
  let cdr: CdrWriter;

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
    bus = new EventBus();
    cdr = new CdrWriter({
      db,
      ari,
      cache: new ConfigCache(db),
      bus,
      state: new StateStore(),
      now: () => NOW
    });
  });

  afterEach(async () => {
    await ari.close();
    await fakeAri.close();
    await db.destroy();
  });

  it('writes one calls row with status, answeredAt and endedAt at finish', async () => {
    await seedSettings(db, 'events');
    const call = buildCall();
    call.status = 'answered';
    call.answeredAt = '2026-01-01T00:00:02.000Z';

    await cdr.finish(call);

    const row = await db
      .selectFrom('calls')
      .selectAll()
      .where('id', '=', call.id)
      .executeTakeFirstOrThrow();
    expect(row.status).toBe('answered');
    expect(row.answeredAt).toBe('2026-01-01T00:00:02.000Z');
    expect(row.startedAt).toBe('2026-01-01T00:00:00.000Z');
    expect(row.endedAt).toBe(NOW);
  });

  it('emits history.appended carrying the call id', async () => {
    await seedSettings(db, 'events');
    const call = buildCall();
    call.status = 'missed';
    const received: Envelope[] = [];
    bus.subscribe(envelope => {
      received.push(envelope);
    });

    await cdr.finish(call);

    // `finish` also publishes the call's `ended` state (§10.6); this test is about the history
    // event alone, so it looks for that one rather than asserting the whole bus.
    expect(received).toContainEqual(
      expect.objectContaining({ type: 'history.appended', callId: call.id })
    );
  });

  it('marks a capped log truncated with a trailing marker line', async () => {
    await seedSettings(db, 'events');
    const call = newCall({
      id: newId(),
      direction: 'inbound',
      callerChannelId: 'caller-channel',
      from: '+15559999',
      to: '+15551000',
      startedAt: '2026-01-01T00:00:00.000Z',
      logLevel: 'events',
      callLogMaxBytes: 10
    });
    call.status = 'missed';
    call.log.event({ event: 'first' });
    call.log.event({ event: 'second' });

    await cdr.finish(call);

    const row = await db
      .selectFrom('calls')
      .selectAll()
      .where('id', '=', call.id)
      .executeTakeFirstOrThrow();
    expect(row.log).toContain('"truncated":true');
  });

  it('writes a call_qos row per channel at the resolved level qos and above', async () => {
    await seedSettings(db, 'events');
    // §7: `call_qos` is gated on this call's own resolved level, independent of the tenant
    // default seeded above — an override from the user, trunk or ring group that routed this
    // call can raise it past the tenant's own setting.
    const call = buildCall('qos');
    call.status = 'answered';
    cdr.noteQosLegs(call);
    await cdr.channelEnded(
      endedChannel(
        'caller-channel',
        fakeRtpAudioQos({
          rxjitter: 0.0015,
          txjitter: 0.001,
          rxcount: 998,
          rxploss: 2,
          txploss: 0,
          rtt: 0.042
        })
      )
    );

    await cdr.finish(call);

    const rows = await db
      .selectFrom('callQos')
      .selectAll()
      .where('callId', '=', call.id)
      .execute();
    expect(rows).toEqual([
      expect.objectContaining({
        channelId: 'caller-channel',
        role: 'caller',
        jitterMs: 1.5,
        lossPct: 0.2,
        rttMs: 42,
        rxPackets: 998,
        txPackets: 1000
      })
    ]);
  });

  it('writes no call_qos row below the resolved level qos', async () => {
    await seedSettings(db, 'events');
    const call = buildCall('events');
    call.status = 'answered';
    cdr.noteQosLegs(call);
    await cdr.channelEnded(endedChannel('caller-channel'));

    await cdr.finish(call);

    const rows = await db
      .selectFrom('callQos')
      .selectAll()
      .where('callId', '=', call.id)
      .execute();
    expect(rows).toHaveLength(0);
  });

  it('gates call_qos on the resolved level, not the tenant default', async () => {
    // §7: the resolved level is the max of the tenant default and this call's own overrides; a
    // high tenant default alone, with no override on this particular call, keeps it at `events`.
    await seedSettings(db, 'qos');
    const call = buildCall('events');
    call.status = 'answered';
    cdr.noteQosLegs(call);
    await cdr.channelEnded(endedChannel('caller-channel'));

    await cdr.finish(call);

    const rows = await db
      .selectFrom('callQos')
      .selectAll()
      .where('callId', '=', call.id)
      .execute();
    expect(rows).toHaveLength(0);
  });
  it('has the placeholder calls row written once open() resolves, however late the driver runs it', async () => {
    await seedSettings(db, 'events');
    const call = buildCall();
    cdr = new CdrWriter({
      db: withSlowCallsInsert(db),
      ari,
      cache: new ConfigCache(db),
      bus,
      state: new StateStore(),
      now: () => NOW
    });

    await cdr.open(call);

    const row = await db
      .selectFrom('calls')
      .select('status')
      .where('id', '=', call.id)
      .executeTakeFirst();
    expect(row?.status).toBe('interrupted');
  });

  it('routes a HEP message to the call whose SIP Call-ID it carries (§7 level sip)', async () => {
    await seedSettings(db, 'sip');
    const call = buildCall('sip');
    fakeAri.addChannel({ id: call.callerChannelId });
    fakeAri.channelVariables.set(
      `${call.callerChannelId}:CHANNEL(pjsip,call-id)`,
      'call-id-abc@10.0.0.1'
    );

    await cdr.open(call);
    await waitFor(() => cdr.knowsCallId('call-id-abc@10.0.0.1'));
    cdr.sipMessage({
      callId: 'call-id-abc@10.0.0.1',
      at: '2026-01-01T00:00:01.000Z',
      direction: 'in',
      payload: 'INVITE sip:101@pbx SIP/2.0'
    });

    const { log } = call.log.finish();
    expect(log).toContain('INVITE sip:101@pbx');
  });

  it('records the dialog of a call released at once, its final response included (§7 level sip)', async () => {
    // next.app.zamfono.com on 2026-09-29: a DID that matched nothing released the call 12 ms in,
    // before its Call-ID was read, and Asterisk's 404 left after the log had been written.
    await seedSettings(db, 'sip');
    const call = buildCall('sip');
    fakeAri.addChannel({ id: call.callerChannelId });
    fakeAri.channelVariables.set(
      `${call.callerChannelId}:CHANNEL(pjsip,call-id)`,
      'call-id-404@10.0.0.1'
    );
    cdr = new CdrWriter({
      db,
      ari,
      cache: new ConfigCache(db),
      bus,
      state: new StateStore(),
      now: () => NOW,
      sipTailMs: 50
    });

    await cdr.open(call);
    expect(cdr.knowsCallId('call-id-404@10.0.0.1')).toBe(true);
    const finishing = cdr.finish(call);
    cdr.sipMessage({
      callId: 'call-id-404@10.0.0.1',
      at: '2026-01-01T00:00:01.000Z',
      direction: 'out',
      payload: 'SIP/2.0 404 Not Found'
    });
    await finishing;

    const row = await db
      .selectFrom('calls')
      .select('log')
      .where('id', '=', call.id)
      .executeTakeFirstOrThrow();
    expect(row.log).toContain('SIP/2.0 404 Not Found');
  });

  it('drops a HEP message whose Call-ID belongs to no open call', () => {
    const call = buildCall('sip');

    cdr.sipMessage({
      callId: 'not-a-call@10.0.0.1',
      at: '2026-01-01T00:00:01.000Z',
      direction: 'in',
      payload: 'OPTIONS sip:pbx SIP/2.0'
    });

    expect(call.log.finish().log ?? '').not.toContain('OPTIONS');
  });
  it('writes the call_qos row of a channel that ends after the call is written (§7)', async () => {
    await seedSettings(db, 'qos');
    const call = buildCall('qos');
    await cdr.open(call);
    call.answeredAt = '2026-01-01T00:00:01.000Z';
    call.status = 'answered';

    // Every call-ending path hangs the caller up and writes the call without waiting for its
    // `ChannelDestroyed`, which carries the statistics Asterisk set as it hung the channel up.
    await cdr.finish(call);
    await cdr.channelEnded(endedChannel(call.callerChannelId));

    const rows = await db
      .selectFrom('callQos')
      .selectAll()
      .where('callId', '=', call.id)
      .execute();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.role).toBe('caller');
  });

  it('takes a leg’s RTCP reports, joined by its Call-ID, into its call_qos row (§7 level qos)', async () => {
    await seedSettings(db, 'qos');
    const call = buildCall('qos');
    fakeAri.addChannel({ id: call.callerChannelId });
    fakeAri.channelVariables.set(
      `${call.callerChannelId}:CHANNEL(pjsip,call-id)`,
      'call-id-rtcp@10.0.0.1'
    );
    await cdr.open(call);
    await waitFor(() => cdr.knowsCallId('call-id-rtcp@10.0.0.1'));
    const sentAt = 1_790_000_000_000;
    const report = parseRtcpReport(
      rtcpPayload({
        ssrc: 8,
        blocks: [
          { sourceSsrc: 7, lsr: ntpMiddle(sentAt), dlsr: fixedPoint(0.1) }
        ]
      })
    );
    if (report === null) {
      throw new Error('not a report');
    }
    cdr.rtcpReport({
      callId: 'call-id-rtcp@10.0.0.1',
      atMs: sentAt + 150,
      sender: 'peer',
      report
    });
    call.answeredAt = '2026-01-01T00:00:01.000Z';
    call.status = 'answered';

    await cdr.finish(call);
    await cdr.channelEnded(
      endedChannel(call.callerChannelId, fakeRtpAudioQos({ rtt: 0 }))
    );

    const row = await db
      .selectFrom('callQos')
      .select(['jitterMs', 'rttMs'])
      .where('callId', '=', call.id)
      .executeTakeFirstOrThrow();
    expect(row.jitterMs).toBe(3.4);
    expect(row.rttMs).toBeCloseTo(50, 1);
  });
});
