import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { newId, nowIso, openDb, type Db } from '@zamfono/shared';
import { migrateForTest } from '@zamfono/shared/testDb.js';

import { AmiClient } from '../ami/client.js';
import { AriClient } from '../ari/client.js';
import { FakeAri } from '../ari/fake.js';
import { isPlacement, placedCallerId } from '../ari/fakeDial.js';
import {
  defaultChannel,
  type AriEvent,
  type Channel,
  type Logger
} from '../ari/types.js';
import { EventBus } from '../internal/eventBus.js';
import { ConfigCache } from '../internal/snapshot.js';
import { StateStore } from '../internal/stateStore.js';
import { PROMPTS } from '../prompts.js';
import { ATTEMPT_NO_RESPONSE_MS } from '../routing/trunk.js';
import { eventually } from '../testing/eventually.js';
import { callerChannel, type Call, type Leg } from './call.js';
import { handleOutbound } from './outbound.js';
import { Pipeline } from './pipeline.js';
import type { ParticipationRecorder } from './recordParticipation.js';
import { sipToHangupCause } from './releaseCause.js';
import { TrunkState } from './trunkState.js';

const noopLogger: Logger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined
};
const SETTLE_DELAY_MS = 60;

function fakeCdr(): {
  open: (call: Call) => Promise<void>;
  finish: (call: Call) => Promise<void>;
} {
  return { open: () => Promise.resolve(), finish: () => Promise.resolve() };
}

async function seedSettings(
  db: Db,
  mainDidId: string,
  overrides: {
    emergencyNumbers?: string[];
    callLogLevel?: 'none' | 'events' | 'qos' | 'sip';
  } = {}
): Promise<void> {
  await db
    .insertInto('settings')
    .values({
      id: 1,
      companyName: 'Zamfono',
      mainDidId,
      country: 'DE',
      emergencyNumbersJson: JSON.stringify(
        overrides.emergencyNumbers ?? ['112']
      ),
      ...(overrides.callLogLevel === undefined
        ? {}
        : { callLogLevel: overrides.callLogLevel })
    })
    .execute();
}

async function seedDid(db: Db, number: string): Promise<string> {
  const targetId = newId();
  await db
    .insertInto('forwardTargets')
    .values({
      id: targetId,
      userId: null,
      ringGroupId: null,
      external: '+15550000',
      mailboxUserId: null,
      mailboxRingGroupId: null,
      announcementAudioId: null,
      menuId: null
    })
    .execute();
  const id = newId();
  await db
    .insertInto('dids')
    .values({ id, number, label: null, targetId, createdAt: nowIso() })
    .execute();
  return id;
}

/** The caller's diagnostics override (§7), unset by default. */
type CallerOverrides = { logLevel?: string; logLevelExpiresAt?: string };

async function seedCaller(
  db: Db,
  overrides: CallerOverrides = {}
): Promise<void> {
  const userId = newId();
  await db
    .insertInto('users')
    .values({
      id: userId,
      name: 'Caller',
      email: `${userId}@example.com`,
      logLevel: overrides.logLevel ?? null,
      logLevelExpiresAt: overrides.logLevelExpiresAt ?? null,
      createdAt: nowIso()
    })
    .execute();
  await db
    .insertInto('devices')
    .values({
      id: newId(),
      userId,
      label: 'phone',
      kind: 'manual',
      sipUsername: 'e101-d1',
      sipPasswordEnc: Buffer.from('secret'),
      createdAt: nowIso()
    })
    .execute();
}

type TrunkOverrides = {
  authMode?: 'registration' | 'ip';
  calleridHeader?: 'from' | 'pai' | 'both';
  calleridDidId?: string | null;
  maxChannels?: number | null;
  emergency?: boolean;
};

async function seedTrunk(
  db: Db,
  priority: number,
  overrides: TrunkOverrides = {}
): Promise<string> {
  const id = newId();
  const authMode = overrides.authMode ?? 'registration';
  await db
    .insertInto('trunks')
    .values({
      id,
      name: `trunk-${priority}`,
      priority,
      emergency: Number(overrides.emergency ?? true),
      authMode,
      username: authMode === 'registration' ? `user${priority}` : null,
      passwordEnc: authMode === 'registration' ? Buffer.from('secret') : null,
      inboundAuth: 0,
      transport: 'udp',
      calleridHeader: overrides.calleridHeader ?? 'from',
      maxChannels: overrides.maxChannels ?? null,
      createdAt: nowIso()
    })
    .execute();
  await db
    .insertInto('trunkHosts')
    .values({
      trunkId: id,
      priority: 1,
      host: `sip${priority}.example.com`,
      port: null,
      direction: 'both'
    })
    .execute();
  return id;
}

async function seedRoute(
  db: Db,
  priority: number,
  trunkId: string,
  calleridDidId: string | null = null
): Promise<void> {
  await db
    .insertInto('outboundRoutes')
    .values({
      id: newId(),
      priority,
      trunkId,
      calleridDidId,
      createdAt: nowIso()
    })
    .execute();
}

function outboundEvent(channel: Channel, dialed: string): AriEvent {
  return {
    type: 'StasisStart',
    timestamp: nowIso(),
    application: 'zamfono',
    args: ['outbound', dialed],
    channel
  };
}

function attemptEndpoints(fakeAri: FakeAri): string[] {
  return fakeAri.calls
    .filter(call => isPlacement(call))
    .map(call => (call.body as { endpoint: string }).endpoint);
}

/**
 * The call's ringing trunk leg, once the dial has originated and tracked it; with `previous`, the
 * attempt that follows that one, once `previous` has ended. A leg is tracked only after its
 * originate returned, right before its attempt starts listening for the leg's events, so an event
 * the test emits for the leg from here on reaches the attempt.
 */
function ringingLeg(
  call: Call,
  previous: { channelId: string } | null = null,
  timeoutMs?: number
): Promise<{ channelId: string }> {
  return eventually(() => {
    if (previous !== null) {
      expect(call.legs.get(previous.channelId)?.state).toBe('ended');
    }
    const leg = [...call.legs.values()].find(
      entry => entry.state === 'ringing'
    );
    if (!leg) {
      throw new Error('no ringing trunk leg found');
    }
    return leg;
  }, timeoutMs);
}

/** `cause` is a Q.850 hangup cause, as ARI's real `ChannelDestroyed` carries it, and `techCause`
 * the SIP response Asterisk 22 adds as `tech_cause` when the channel ended on one. */
function emitDestroyed(
  fakeAri: FakeAri,
  channelId: string,
  cause: number,
  techCause?: number
): void {
  fakeAri.emit({
    type: 'ChannelDestroyed',
    timestamp: nowIso(),
    application: 'zamfono',
    channel: defaultChannel({ id: channelId }),
    cause,
    // eslint-disable-next-line camelcase -- ARI's own field name
    ...(techCause === undefined ? {} : { tech_cause: techCause })
  });
}

function emitState(fakeAri: FakeAri, channelId: string, state: string): void {
  fakeAri.emit({
    type: 'ChannelStateChange',
    timestamp: nowIso(),
    application: 'zamfono',
    channel: defaultChannel({ id: channelId, state })
  });
}

/** ARI's `Dial` event for an originated channel, whose `peer` it is (§9.4 "Route fallthrough"). */
function emitDialStatus(
  fakeAri: FakeAri,
  channelId: string,
  dialstatus: string
): void {
  fakeAri.emit({
    type: 'Dial',
    timestamp: nowIso(),
    application: 'zamfono',
    peer: defaultChannel({ id: channelId, state: 'Down' }),
    dialstatus
  });
}

/** A recorder that only notes which participations each answer offered it (§10.2). */
function spyRecorder(): ParticipationRecorder & {
  callers: Call[];
  legs: Leg[];
} {
  const callers: Call[] = [];
  const legs: Leg[] = [];
  return {
    callers,
    legs,
    onCallerUp: call => {
      callers.push(call);
      return Promise.resolve();
    },
    onLegUp: (_call, leg) => {
      legs.push(leg);
      return Promise.resolve();
    },
    onTransfereeUp: () => Promise.resolve(),
    onCallerEnded: () => Promise.resolve(),
    onLegEnded: () => Promise.resolve()
  };
}

/** The `event` names of the call's routing-trace lines, in order. */
function traceEvents(call: Call): string[] {
  return (call.log.finish().log ?? '')
    .split('\n')
    .filter(Boolean)
    .map(line => String((JSON.parse(line) as { event?: string }).event));
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => {
    setTimeout(resolve, ms);
  });
}

/** Whether the core set `channelId`'s language to `language` (§9.1). */
function languageSet(
  fakeAri: FakeAri,
  channelId: string,
  language: string
): boolean {
  return fakeAri.calls.some(
    entry =>
      entry.method === 'POST' &&
      entry.path === `channels/${channelId}/variable` &&
      (entry.body as { variable?: string }).variable === 'CHANNEL(language)' &&
      (entry.body as { value?: string }).value === language
  );
}

describe('outbound dialing', () => {
  // eslint-disable-next-line init-declarations -- assigned in beforeEach before each test runs
  let db: Db;
  // eslint-disable-next-line init-declarations -- assigned in beforeEach before each test runs
  let fakeAri: FakeAri;
  // eslint-disable-next-line init-declarations -- assigned in beforeEach before each test runs
  let ari: AriClient;
  // eslint-disable-next-line init-declarations -- assigned in beforeEach before each test runs
  let ami: AmiClient;
  // eslint-disable-next-line init-declarations -- assigned in beforeEach before each test runs
  let pipeline: Pipeline;
  // eslint-disable-next-line init-declarations -- assigned in beforeEach before each test runs
  let trunkState: TrunkState;
  // eslint-disable-next-line init-declarations -- assigned in beforeEach before each test runs
  let state: StateStore;

  beforeEach(async () => {
    db = openDb(':memory:');
    await migrateForTest(db);
    fakeAri = new FakeAri();
    fakeAri.answerAfterMs = 20;
    const { url } = await fakeAri.listen();
    ari = new AriClient({
      url,
      user: 'zamfono',
      password: 'secret',
      app: 'zamfono',
      log: noopLogger
    });
    await ari.connect();
    ami = new AmiClient({
      host: '127.0.0.1',
      port: 1,
      username: 'zamfono',
      password: 'secret',
      log: noopLogger
    });
    state = new StateStore();
    pipeline = new Pipeline({
      ari,
      cache: new ConfigCache(db),
      state,
      bus: new EventBus(),
      cdr: fakeCdr(),
      now: nowIso,
      trunkState: null,
      presence: null
    });
    trunkState = new TrunkState({
      log: noopLogger,
      ari,
      ami,
      cache: new ConfigCache(db),
      state,
      bus: new EventBus(),
      now: nowIso
    });
    pipeline.deps.trunkState = trunkState;
  });

  afterEach(async () => {
    vi.useRealTimers();
    await ari.close();
    await fakeAri.close();
    await db.destroy();
  });

  async function startDial(
    dialed: string,
    caller: CallerOverrides = {}
  ): Promise<{ call: Call; finished: Promise<void> }> {
    await seedCaller(db, caller);
    const channel = fakeAri.addChannel({
      name: 'PJSIP/e101-d1',
      caller: { number: '101', name: '' }
    });
    const finished = handleOutbound(pipeline, outboundEvent(channel, dialed));
    const call = await eventually(() => {
      const registered = pipeline.callByChannel.get(channel.id);
      if (!registered) {
        throw new Error('call was not registered');
      }
      return registered;
    });
    return { call, finished };
  }

  async function dial(
    dialed: string,
    caller: CallerOverrides = {}
  ): Promise<Call> {
    const { call, finished } = await startDial(dialed, caller);
    await finished;
    return call;
  }

  it('selects the first matching route trunk and presents the route DID', async () => {
    const mainDidId = await seedDid(db, '+491110000');
    await seedSettings(db, mainDidId);
    const routeDidId = await seedDid(db, '+491230000');
    const trunkId = await seedTrunk(db, 1, { calleridDidId: routeDidId });
    await seedRoute(db, 1, trunkId, routeDidId);

    const call = await dial('+498912345');

    expect(call.status).toBe('answered');
    const originate = fakeAri.calls.find(entry => isPlacement(entry));
    expect(placedCallerId(originate ?? { body: undefined })).toBe('+491230000');
    expect((originate?.body as { endpoint: string }).endpoint).toBe(
      `PJSIP/+498912345@trunk-${trunkId}`
    );
  });

  // §7: the call's level is the maximum of the tenant default and the overrides of the user and
  // the trunk (among others) that routed it.
  it('raises the call to the calling user’s diagnostics override', async () => {
    const mainDidId = await seedDid(db, '+491110000');
    await seedSettings(db, mainDidId);
    const trunkId = await seedTrunk(db, 1);
    await seedRoute(db, 1, trunkId);

    const call = await dial('+498912345', {
      logLevel: 'qos',
      logLevelExpiresAt: '2999-01-01T00:00:00.000Z'
    });

    expect(call.log.level).toBe('qos');
  });

  it('raises the call to the diagnostics override of the trunk it leaves over', async () => {
    const mainDidId = await seedDid(db, '+491110000');
    await seedSettings(db, mainDidId);
    const trunkId = await seedTrunk(db, 1);
    await db
      .updateTable('trunks')
      .set({ logLevel: 'sip', logLevelExpiresAt: '2999-01-01T00:00:00.000Z' })
      .where('id', '=', trunkId)
      .execute();
    await seedRoute(db, 1, trunkId);

    const call = await dial('+498912345');

    expect(call.log.level).toBe('sip');
  });

  // §7 level `sip`: the trunk leg's dialog is part of the call's SIP log.
  it('joins the trunk leg it originates to the call’s SIP capture', async () => {
    const mainDidId = await seedDid(db, '+491110000');
    await seedSettings(db, mainDidId);
    const trunkId = await seedTrunk(db, 1);
    await seedRoute(db, 1, trunkId);
    const joined: { callId: string; channelId: string; dialled: boolean }[] =
      [];
    pipeline.deps.cdr.joinLeg = (joinedCall, channelId) => {
      joined.push({
        callId: joinedCall.id,
        channelId,
        dialled: fakeAri.calls.some(
          entry => entry.path === `channels/${channelId}/dial`
        )
      });
      return Promise.resolve();
    };

    const call = await dial('+498912345');

    expect(joined).toHaveLength(1);
    expect(joined[0]?.callId).toBe(call.id);
    expect(joined[0]?.channelId).not.toBe(call.callerChannelId);
    // §7 level `sip`: joined before its INVITE leaves, so a leg refused at once is still the call's.
    expect(joined[0]?.dialled).toBe(false);
  });

  // §10.2 / §9.1: "The core sets every channel's language from `settings.language`", a
  // colleague's own dial included, so an internal call hears the tenant's prompts.
  it('sets the dialling channel’s language from the tenant setting', async () => {
    const mainDidId = await seedDid(db, '+491110000');
    await seedSettings(db, mainDidId);
    await db.updateTable('settings').set({ language: 'de' }).execute();
    const trunkId = await seedTrunk(db, 1);
    await seedRoute(db, 1, trunkId);

    const call = await dial('+498912345');

    expect(languageSet(fakeAri, callerChannel(call), 'de')).toBe(true);
  });

  it('stores the resolved E.164 form in calls.to, the dialled digits only in the trace', async () => {
    const mainDidId = await seedDid(db, '+491110000');
    await seedSettings(db, mainDidId);
    const trunkId = await seedTrunk(db, 1);
    await seedRoute(db, 1, trunkId);

    const call = await dial('089123456');

    expect(call.to).toBe('+4989123456');
    const lines = (call.log.finish().log ?? '').split('\n').filter(Boolean);
    const entry = lines
      .map(line => JSON.parse(line) as { event?: string; dialed?: string })
      .find(line => line.event === 'entry');
    expect(entry?.dialed).toBe('089123456');
  });

  it('stores an own DID dialled in national form as its E.164 number in calls.to (§10.1 Outbound step 4)', async () => {
    const mainDidId = await seedDid(db, '+491110000');
    await seedSettings(db, mainDidId);
    const trunkId = await seedTrunk(db, 1);
    await seedRoute(db, 1, trunkId);

    const call = await dial('01110000');

    expect(call.to).toBe('+491110000');
  });

  it('withholds the number on a both trunk by restricting the presentation of the real number (§9.4 "Anonymous calls (CLIR)")', async () => {
    const mainDidId = await seedDid(db, '+491110000');
    await seedSettings(db, mainDidId);
    const trunkId = await seedTrunk(db, 1, { calleridHeader: 'both' });
    await seedRoute(db, 1, trunkId);

    await dial('#31#+498912345');

    const originate = fakeAri.calls.find(entry => isPlacement(entry));
    const body = originate?.body as {
      callerId: string;
      variables: Record<string, string>;
    };
    // chan_pjsip anonymises `From` and adds `Privacy: id` for a restricted connected line, and
    // `trust_id_outbound` keeps the real number in its `P-Asserted-Identity`.
    expect(placedCallerId(originate ?? { body: undefined })).toBe('+491110000');
    expect(body.variables['CONNECTEDLINE(pres)']).toBe('prohib');
    expect(
      Object.keys(body.variables).filter(name =>
        name.startsWith('PJSIP_HEADER')
      )
    ).toEqual([]);
  });

  it('presents the number as the caller ID on a pai trunk, leaving From and PAI to the endpoint (§9.4 "Caller-ID")', async () => {
    const mainDidId = await seedDid(db, '+491110000');
    await seedSettings(db, mainDidId);
    const trunkId = await seedTrunk(db, 1, { calleridHeader: 'pai' });
    await seedRoute(db, 1, trunkId);

    await dial('+498912345');

    const originate = fakeAri.calls.find(entry => isPlacement(entry));
    const body = originate?.body as {
      callerId: string;
      variables: Record<string, string>;
    };
    // chan_pjsip asserts the caller ID's number itself (`send_pai`), well-formed and once; the
    // endpoint's `from_user` puts the account identity in `From`.
    expect(placedCallerId(originate ?? { body: undefined })).toBe('+491110000');
    expect(body.variables['CALLERID(num)']).toBe('+491110000');
    expect(Object.keys(body.variables)).not.toContain(
      'PJSIP_HEADER(add,P-Asserted-Identity)'
    );
  });

  it('skips a from-only trunk for a withheld call and ends 403 with no other route', async () => {
    const mainDidId = await seedDid(db, '+491110000');
    await seedSettings(db, mainDidId);
    const trunkId = await seedTrunk(db, 1, { calleridHeader: 'from' });
    await seedRoute(db, 1, trunkId);

    const call = await dial('#31#+498912345');

    expect(call.status).toBe('failed');
    expect(attemptEndpoints(fakeAri)).toHaveLength(0);
    const hangup = fakeAri.calls.at(-1);
    expect(hangup?.method).toBe('DELETE');
    expect(hangup?.qs).toBe(`reason_code=${sipToHangupCause(403)}`);
  });

  it('falls through to the second route once the first is over its channel cap', async () => {
    const mainDidId = await seedDid(db, '+491110000');
    await seedSettings(db, mainDidId);
    const trunk1 = await seedTrunk(db, 1, { maxChannels: 1 });
    const trunk2 = await seedTrunk(db, 2);
    await seedRoute(db, 1, trunk1);
    await seedRoute(db, 2, trunk2);
    trunkState.noteAttemptStarted(trunk1);

    const call = await dial('+498912345');

    expect(call.status).toBe('answered');
    expect(attemptEndpoints(fakeAri)).toEqual([
      `PJSIP/+498912345@trunk-${trunk2}`
    ]);
  });

  it('falls through on a 503 before alerting, with one trace line per attempt', async () => {
    const mainDidId = await seedDid(db, '+491110000');
    await seedSettings(db, mainDidId);
    const trunk1 = await seedTrunk(db, 1);
    const trunk2 = await seedTrunk(db, 2);
    await seedRoute(db, 1, trunk1);
    await seedRoute(db, 2, trunk2);
    fakeAri.answerAfterMs = 60_000;

    const { call, finished } = await startDial('+498912345');
    const leg1 = await ringingLeg(call);
    // Q.850 cause 41, temporary failure -> SIP 503.
    emitDestroyed(fakeAri, leg1.channelId, 41);
    const leg2 = await ringingLeg(call, leg1);
    emitState(fakeAri, leg2.channelId, 'Up');
    await finished;

    expect(call.status).toBe('answered');
    expect(attemptEndpoints(fakeAri)).toEqual([
      `PJSIP/+498912345@trunk-${trunk1}`,
      `PJSIP/+498912345@trunk-${trunk2}`
    ]);
    const lines = call.log
      .finish()
      .log?.split('\n')
      .filter(
        line => (JSON.parse(line) as { event?: string }).event === 'attempt'
      );
    expect(lines).toHaveLength(2);
  });

  /** The `cause` of each `attempt` trace line, in order. */
  function attemptCauses(call: Call): unknown[] {
    return (call.log.finish().log ?? '')
      .split('\n')
      .filter(Boolean)
      .map(line => JSON.parse(line) as { event?: string; cause?: unknown })
      .filter(line => line.event === 'attempt')
      .map(line => line.cause);
  }

  // A leg Asterisk will not place fails its attempt before alerting, as a 500 would: the next
  // route is tried, and a call none of whose legs could be placed ends released.
  it('falls through to the next route when a trunk leg’s dial is refused, tracing placementFailed', async () => {
    const mainDidId = await seedDid(db, '+491110000');
    await seedSettings(db, mainDidId);
    const trunk1 = await seedTrunk(db, 1);
    const trunk2 = await seedTrunk(db, 2);
    await seedRoute(db, 1, trunk1);
    await seedRoute(db, 2, trunk2);
    fakeAri.failDial = { status: 409, count: 1 };

    const call = await dial('+498912345');

    expect(call.status).toBe('answered');
    expect(attemptEndpoints(fakeAri)).toEqual([
      `PJSIP/+498912345@trunk-${trunk1}`,
      `PJSIP/+498912345@trunk-${trunk2}`
    ]);
    expect(attemptCauses(call)).toEqual(['placementFailed', 'answered']);
  });

  it('releases the call when no trunk leg can be created, tracing each attempt', async () => {
    const mainDidId = await seedDid(db, '+491110000');
    await seedSettings(db, mainDidId);
    const trunk1 = await seedTrunk(db, 1);
    const trunk2 = await seedTrunk(db, 2);
    await seedRoute(db, 1, trunk1);
    await seedRoute(db, 2, trunk2);
    fakeAri.failOriginate = { status: 500 };

    const call = await dial('+498912345');

    expect(call.status).toBe('failed');
    expect(attemptCauses(call)).toEqual(['placementFailed', 'placementFailed']);
    expect(
      fakeAri.calls.some(
        entry =>
          entry.method === 'DELETE' &&
          entry.path === `channels/${call.callerChannelId}`
      )
    ).toBe(true);
  });

  it('releases the call when no created trunk leg ever enters the app, dialling none', async () => {
    const mainDidId = await seedDid(db, '+491110000');
    await seedSettings(db, mainDidId);
    const trunkId = await seedTrunk(db, 1);
    await seedRoute(db, 1, trunkId);
    fakeAri.createdEntersStasis = false;
    pipeline.deps.legStasisWaitMs = SETTLE_DELAY_MS;

    const call = await dial('+498912345');

    expect(call.status).toBe('failed');
    expect(attemptCauses(call)).toEqual(['placementFailed']);
    expect(fakeAri.calls.some(entry => entry.path.endsWith('/dial'))).toBe(
      false
    );
  });

  it('ends busy on a 486 with no second attempt', async () => {
    const mainDidId = await seedDid(db, '+491110000');
    await seedSettings(db, mainDidId);
    const trunkId = await seedTrunk(db, 1);
    await seedRoute(db, 1, trunkId);
    fakeAri.answerAfterMs = 60_000;

    const { call, finished } = await startDial('+498912345');
    const leg = await ringingLeg(call);
    // Q.850 cause 17, user busy -> SIP 486.
    emitDestroyed(fakeAri, leg.channelId, 17);
    await finished;

    expect(call.status).toBe('busy');
    expect(attemptEndpoints(fakeAri)).toHaveLength(1);
  });

  it('falls through to the next route on a 403, which chan_pjsip reports as Q.850 21 like a 603', async () => {
    const mainDidId = await seedDid(db, '+491110000');
    await seedSettings(db, mainDidId);
    const trunk1 = await seedTrunk(db, 1);
    const trunk2 = await seedTrunk(db, 2);
    await seedRoute(db, 1, trunk1);
    await seedRoute(db, 2, trunk2);
    fakeAri.answerAfterMs = 60_000;

    const { call, finished } = await startDial('+498912345');
    const leg1 = await ringingLeg(call);
    // Q.850 21, call rejected, is also what a 603 maps to; only `tech_cause` names the 403.
    emitDestroyed(fakeAri, leg1.channelId, 21, 403);
    const leg2 = await ringingLeg(call, leg1);
    emitState(fakeAri, leg2.channelId, 'Up');
    await finished;

    expect(call.status).toBe('answered');
    expect(attemptEndpoints(fakeAri)).toEqual([
      `PJSIP/+498912345@trunk-${trunk1}`,
      `PJSIP/+498912345@trunk-${trunk2}`
    ]);
  });

  it('falls through on a 403 whose channel ended before the originate returned', async () => {
    const mainDidId = await seedDid(db, '+491110000');
    await seedSettings(db, mainDidId);
    const trunk1 = await seedTrunk(db, 1);
    const trunk2 = await seedTrunk(db, 2);
    await seedRoute(db, 1, trunk1);
    await seedRoute(db, 2, trunk2);
    fakeAri.answerAfterMs = 60_000;
    // Asterisk sends the INVITE while it answers the originate; a far end that refuses at once
    // has the channel destroyed before the core learns its id.
    let refused = '';
    fakeAri.onOriginate = channel => {
      fakeAri.onOriginate = null;
      refused = channel.id;
      emitDestroyed(fakeAri, channel.id, 21, 403);
    };

    const { call, finished } = await startDial('+498912345');
    const channelId = await eventually(() => {
      expect(refused).not.toBe('');
      return refused;
    });
    const leg2 = await ringingLeg(call, { channelId });
    emitState(fakeAri, leg2.channelId, 'Up');
    await finished;

    expect(call.status).toBe('answered');
    const lines = (call.log.finish().log ?? '')
      .split('\n')
      .filter(Boolean)
      .map(line => JSON.parse(line) as Record<string, unknown>);
    const attempts = lines.filter(entry => entry.event === 'attempt');
    expect(attempts.map(entry => entry.cause)).toEqual([403, 'answered']);
    // §7: each attempt names the caller ID it presented, and the answer the trunk it came over.
    expect(attempts[1]).toMatchObject({
      trunkId: trunk2,
      callerId: {
        number: '+491110000',
        format: 'e164',
        header: 'from',
        withheld: false
      }
    });
    expect(lines).toContainEqual(
      expect.objectContaining({
        event: 'answered',
        channelId: leg2.channelId,
        leg: 'trunk',
        trunkId: trunk2
      })
    );
  });

  it('ends on a 603 before alerting, the callee declining, without trying the next route', async () => {
    const mainDidId = await seedDid(db, '+491110000');
    await seedSettings(db, mainDidId);
    const trunk1 = await seedTrunk(db, 1);
    const trunk2 = await seedTrunk(db, 2);
    await seedRoute(db, 1, trunk1);
    await seedRoute(db, 2, trunk2);
    fakeAri.answerAfterMs = 60_000;

    const { call, finished } = await startDial('+498912345');
    const leg = await ringingLeg(call);
    emitDestroyed(fakeAri, leg.channelId, 21, 603);
    await finished;

    expect(attemptEndpoints(fakeAri)).toEqual([
      `PJSIP/+498912345@trunk-${trunk1}`
    ]);
  });

  it('ends without a second attempt on a 500 that arrives after alerting', async () => {
    const mainDidId = await seedDid(db, '+491110000');
    await seedSettings(db, mainDidId);
    const trunkId = await seedTrunk(db, 1);
    await seedRoute(db, 1, trunkId);
    fakeAri.answerAfterMs = 60_000;

    const { call, finished } = await startDial('+498912345');
    const leg = await ringingLeg(call);
    emitState(fakeAri, leg.channelId, 'Ringing');
    await sleep(SETTLE_DELAY_MS);
    // Q.850 cause 111, protocol error -> SIP 500.
    emitDestroyed(fakeAri, leg.channelId, 111);
    await finished;

    expect(call.status).toBe('missed');
    expect(attemptEndpoints(fakeAri)).toHaveLength(1);
  });

  it('hangs up and tries the next route after 8s with no provisional response', async () => {
    const mainDidId = await seedDid(db, '+491110000');
    await seedSettings(db, mainDidId);
    const trunk1 = await seedTrunk(db, 1);
    const trunk2 = await seedTrunk(db, 2);
    await seedRoute(db, 1, trunk1);
    await seedRoute(db, 2, trunk2);
    fakeAri.answerAfterMs = 60_000;
    vi.useFakeTimers({
      toFake: ['setTimeout', 'clearTimeout'],
      shouldAdvanceTime: true
    });

    const { call, finished } = await startDial('+498912345');
    const leg1 = await ringingLeg(call);
    await vi.advanceTimersByTimeAsync(ATTEMPT_NO_RESPONSE_MS);
    const leg2 = await ringingLeg(call, leg1);
    emitState(fakeAri, leg2.channelId, 'Up');
    await finished;

    expect(call.status).toBe('answered');
    expect(attemptEndpoints(fakeAri)).toEqual([
      `PJSIP/+498912345@trunk-${trunk1}`,
      `PJSIP/+498912345@trunk-${trunk2}`
    ]);
    const timedOutHangup = fakeAri.calls.some(
      entry =>
        entry.method === 'DELETE' &&
        entry.path.startsWith(`channels/${[...call.legs.keys()][0]}`)
    );
    expect(timedOutHangup).toBe(true);
  });

  it('refuses a call that matches no route with 503, unanswered, with no announcement and a trace line (§9.4)', async () => {
    const mainDidId = await seedDid(db, '+491110000');
    await seedSettings(db, mainDidId);

    const call = await dial('+498912345');

    expect(call.status).toBe('failed');

    // §9.1 sets every channel's language, a refused one's included; beyond that the channel is
    // only released: no answer and no playback.
    const touched = fakeAri.calls.filter(
      entry =>
        entry.path.startsWith(`channels/${call.callerChannelId}`) &&
        (entry.body as { variable?: string } | undefined)?.variable !==
          'CHANNEL(language)'
    );
    expect(touched.map(entry => `${entry.method} ${entry.path}`)).toEqual([
      `DELETE channels/${call.callerChannelId}`
    ]);
    expect(touched[0]?.qs).toBe(`reason_code=${sipToHangupCause(503)}`);
    expect(traceEvents(call)).toContain('noRoute');
  });

  it('plays the failed-call announcement before releasing an exhausted route list', async () => {
    const mainDidId = await seedDid(db, '+491110000');
    await seedSettings(db, mainDidId);
    const trunkId = await seedTrunk(db, 1);
    await seedRoute(db, 1, trunkId);
    state.trunks.set(trunkId, {
      status: 'unreachable',
      statusChangedAt: nowIso()
    });

    const call = await dial('+498912345');

    expect(call.status).toBe('failed');
    const relevant = fakeAri.calls.filter(
      entry =>
        entry.path === `channels/${call.callerChannelId}/answer` ||
        entry.path === `channels/${call.callerChannelId}/play` ||
        (entry.method === 'DELETE' &&
          entry.path.startsWith(`channels/${call.callerChannelId}`))
    );
    expect(relevant.map(entry => entry.method)).toEqual([
      'POST',
      'POST',
      'DELETE'
    ]);
    // A core-sounds prompt the image ships (§9.1), which the harness's prompt check covers.
    expect(relevant[1]?.body).toMatchObject({
      media: `sound:${PROMPTS.failedCall}`
    });
  });

  it('dials the second trunk in priority order when the first is unreachable', async () => {
    const mainDidId = await seedDid(db, '+491110000');
    await seedSettings(db, mainDidId, { emergencyNumbers: ['112'] });
    const trunk1 = await seedTrunk(db, 1);
    const trunk2 = await seedTrunk(db, 2);
    state.trunks.set(trunk1, {
      status: 'unreachable',
      statusChangedAt: nowIso()
    });

    const call = await dial('112');

    expect(call.status).toBe('answered');
    expect(attemptEndpoints(fakeAri)).toEqual([`PJSIP/112@trunk-${trunk2}`]);
  });

  it('never dials a trunk without the emergency flag, even ahead in the trunk order (§9.4 "Emergency trunks")', async () => {
    const mainDidId = await seedDid(db, '+491110000');
    await seedSettings(db, mainDidId, { emergencyNumbers: ['112'] });
    await seedTrunk(db, 1, { emergency: false });
    const trunk2 = await seedTrunk(db, 2);

    const call = await dial('112');

    expect(call.status).toBe('answered');
    expect(attemptEndpoints(fakeAri)).toEqual([`PJSIP/112@trunk-${trunk2}`]);
  });

  it('fails with an ERROR line while only trunks without the emergency flag are live (§10.1)', async () => {
    const mainDidId = await seedDid(db, '+491110000');
    await seedSettings(db, mainDidId, { emergencyNumbers: ['112'] });
    await seedTrunk(db, 1, { emergency: false });
    let loggedError: Record<string, unknown> | string | null = null;
    pipeline.deps.logger = {
      info: () => undefined,
      warn: () => undefined,
      error: fields => {
        loggedError = fields;
      }
    };

    const call = await dial('112');

    expect(call.status).toBe('failed');
    expect(attemptEndpoints(fakeAri)).toEqual([]);
    expect(loggedError).not.toBeNull();
  });

  it('logs ERROR and keeps its trace at events despite a none tenant default when no trunk is live', async () => {
    const mainDidId = await seedDid(db, '+491110000');
    await seedSettings(db, mainDidId, {
      emergencyNumbers: ['112'],
      callLogLevel: 'none'
    });
    let loggedError: Record<string, unknown> | string | null = null;
    pipeline.deps.logger = {
      info: () => undefined,
      warn: () => undefined,
      error: fields => {
        loggedError = fields;
      }
    };

    const call = await dial('112');

    expect(call.status).toBe('failed');
    expect(loggedError).not.toBeNull();
    const lines = (call.log.finish().log ?? '').split('\n').filter(Boolean);
    expect(
      lines.some(
        line =>
          (JSON.parse(line) as { event?: string }).event === 'emergencyFailed'
      )
    ).toBe(true);
  });

  it('logs no ERROR for an emergency call whose live trunks were tried and failed (§10.1)', async () => {
    const mainDidId = await seedDid(db, '+491110000');
    await seedSettings(db, mainDidId, { emergencyNumbers: ['112'] });
    await seedTrunk(db, 1);
    let loggedError: Record<string, unknown> | string | null = null;
    pipeline.deps.logger = {
      info: () => undefined,
      warn: () => undefined,
      error: fields => {
        loggedError = fields;
      }
    };
    fakeAri.answerAfterMs = 60_000;

    const { call, finished } = await startDial('112');
    // Q.850 cause 41, temporary failure -> SIP 503: the one live trunk failed, but it is live.
    emitDestroyed(fakeAri, (await ringingLeg(call)).channelId, 41);
    await finished;

    expect(call.status).toBe('failed');
    expect(fakeAri.calls.at(-1)?.qs).toBe(
      `reason_code=${sipToHangupCause(503)}`
    );
    expect(loggedError).toBeNull();
    expect(traceEvents(call)).toContain('emergencyFailed');
  });

  it('an answered outbound call is recorded, shown up and traced once, like every answer', async () => {
    const mainDidId = await seedDid(db, '+491110000');
    await seedSettings(db, mainDidId);
    const trunkId = await seedTrunk(db, 1);
    await seedRoute(db, 1, trunkId);
    const recorder = spyRecorder();
    pipeline.deps.recorder = recorder;
    const states: string[] = [];
    pipeline.deps.bus.subscribe(envelope => {
      if (envelope.type === 'call.state') {
        states.push(envelope.state);
      }
    });

    const call = await dial('+498912345');

    expect(call.status).toBe('answered');
    // §10.2: the caller's own participation (their `record_calls` on a PSTN call) is offered;
    // the trunk leg is offered too, and the recorder finds no user behind it.
    expect(recorder.callers).toEqual([call]);
    expect(recorder.legs.map(leg => leg.kind)).toEqual(['trunk']);
    expect(states).toEqual(['ringing', 'up']);
    expect(state.calls.get(call.id)?.state).toBe('up');
    expect(
      traceEvents(call).filter(event => event === 'answered')
    ).toHaveLength(1);
  });

  it('names the placing user among every call.state event’s participants (§10.6 "own calls")', async () => {
    const mainDidId = await seedDid(db, '+491110000');
    await seedSettings(db, mainDidId);
    const trunkId = await seedTrunk(db, 1);
    await seedRoute(db, 1, trunkId);
    const events: { userId: string | null; userIds: string[] }[] = [];
    pipeline.deps.bus.subscribe(envelope => {
      if (envelope.type === 'call.state') {
        events.push({ userId: envelope.userId, userIds: envelope.userIds });
      }
    });

    const call = await dial('+498912345');

    expect(call.callerUserId).not.toBeNull();
    expect(events).toHaveLength(2);
    for (const event of events) {
      // No callee or answering user on a PSTN call: `userId` names nobody the caller could match.
      expect(event.userId).toBeNull();
      expect(event.userIds).toEqual([call.callerUserId]);
    }
  });

  it('an answered emergency call is recorded and shown up like every answer', async () => {
    const mainDidId = await seedDid(db, '+491110000');
    await seedSettings(db, mainDidId, { emergencyNumbers: ['112'] });
    await seedTrunk(db, 1);
    const recorder = spyRecorder();
    pipeline.deps.recorder = recorder;

    const call = await dial('112');

    expect(call.status).toBe('answered');
    expect(recorder.callers).toEqual([call]);
    expect(state.calls.get(call.id)?.state).toBe('up');
    expect(
      traceEvents(call).filter(event => event === 'answered')
    ).toHaveLength(1);
  });

  it('tries the second host of an ip trunk before the next route', async () => {
    const mainDidId = await seedDid(db, '+491110000');
    await seedSettings(db, mainDidId);
    const trunk1 = await seedTrunk(db, 1, { authMode: 'ip' });
    await db
      .insertInto('trunkHosts')
      .values({
        trunkId: trunk1,
        priority: 2,
        host: 'sip1b.example.com',
        port: null,
        direction: 'both'
      })
      .execute();
    const trunk2 = await seedTrunk(db, 2);
    await seedRoute(db, 1, trunk1);
    await seedRoute(db, 2, trunk2);
    fakeAri.answerAfterMs = 60_000;

    const { call, finished } = await startDial('+498912345');
    const legHost1 = await ringingLeg(call);
    // Q.850 cause 41, temporary failure -> SIP 503.
    emitDestroyed(fakeAri, legHost1.channelId, 41);
    const legHost2 = await ringingLeg(call, legHost1);
    expect(legHost2.channelId).not.toBe(legHost1.channelId);
    emitState(fakeAri, legHost2.channelId, 'Up');
    await finished;

    expect(call.status).toBe('answered');
    expect(attemptEndpoints(fakeAri)).toEqual([
      `PJSIP/+498912345@trunk-${trunk1}/sip:sip1.example.com`,
      `PJSIP/+498912345@trunk-${trunk1}/sip:sip1b.example.com`
    ]);
  });

  it('does not re-route at 8s once the far end alerted before that', async () => {
    const mainDidId = await seedDid(db, '+491110000');
    await seedSettings(db, mainDidId);
    const trunk1 = await seedTrunk(db, 1);
    const trunk2 = await seedTrunk(db, 2);
    await seedRoute(db, 1, trunk1);
    await seedRoute(db, 2, trunk2);
    fakeAri.answerAfterMs = 60_000;
    vi.useFakeTimers({
      toFake: ['setTimeout', 'clearTimeout'],
      shouldAdvanceTime: true
    });

    const { call, finished } = await startDial('+498912345');
    const leg = await ringingLeg(call);
    emitState(fakeAri, leg.channelId, 'Ringing');
    await vi.advanceTimersByTimeAsync(ATTEMPT_NO_RESPONSE_MS + 300);
    emitState(fakeAri, leg.channelId, 'Up');
    await finished;

    expect(call.status).toBe('answered');
    expect(attemptEndpoints(fakeAri)).toEqual([
      `PJSIP/+498912345@trunk-${trunk1}`
    ]);
  });

  it('keeps an attempt past 8s whose far end answered 183 Session Progress, which leaves the channel Down', async () => {
    const mainDidId = await seedDid(db, '+491110000');
    await seedSettings(db, mainDidId);
    const trunk1 = await seedTrunk(db, 1);
    const trunk2 = await seedTrunk(db, 2);
    await seedRoute(db, 1, trunk1);
    await seedRoute(db, 2, trunk2);
    fakeAri.answerAfterMs = 60_000;
    vi.useFakeTimers({
      toFake: ['setTimeout', 'clearTimeout'],
      shouldAdvanceTime: true
    });

    const { call, finished } = await startDial('+498912345');
    const leg = await ringingLeg(call);
    // Asterisk 22 reports a 183 only as a `Dial` event on the originated channel.
    emitDialStatus(fakeAri, leg.channelId, 'PROGRESS');
    await vi.advanceTimersByTimeAsync(ATTEMPT_NO_RESPONSE_MS + 300);
    emitState(fakeAri, leg.channelId, 'Up');
    await finished;

    expect(call.status).toBe('answered');
    expect(attemptEndpoints(fakeAri)).toEqual([
      `PJSIP/+498912345@trunk-${trunk1}`
    ]);
  });

  it('keeps an attempt past 8s whose far end answered only 100 Trying, which no event reports', async () => {
    const mainDidId = await seedDid(db, '+491110000');
    await seedSettings(db, mainDidId);
    const trunk1 = await seedTrunk(db, 1);
    const trunk2 = await seedTrunk(db, 2);
    await seedRoute(db, 1, trunk1);
    await seedRoute(db, 2, trunk2);
    fakeAri.answerAfterMs = 60_000;
    vi.useFakeTimers({
      toFake: ['setTimeout', 'clearTimeout'],
      shouldAdvanceTime: true
    });

    const { call, finished } = await startDial('+498912345');
    const leg = await ringingLeg(call);
    // chan_pjsip records every response in the channel's hangup-cause hash; the fake names an
    // originated channel after its endpoint.
    fakeAri.channelVariables.set(
      `${leg.channelId}:HANGUPCAUSE(PJSIP/+498912345@trunk-${trunk1},tech)`,
      'SIP 100 Trying'
    );
    await vi.advanceTimersByTimeAsync(ATTEMPT_NO_RESPONSE_MS + 300);
    // A 486 after a bare 100 is the callee's own condition, final on the first route.
    emitDestroyed(fakeAri, leg.channelId, 17);
    await finished;

    expect(call.status).toBe('busy');
    expect(attemptEndpoints(fakeAri)).toEqual([
      `PJSIP/+498912345@trunk-${trunk1}`
    ]);
  });

  it('does not count a hop for an internal-extension or own-DID dispatch', async () => {
    const mainDidId = await seedDid(db, '+491110000');
    await seedSettings(db, mainDidId);
    const targetUserId = newId();
    await db
      .insertInto('users')
      .values({
        id: targetUserId,
        name: 'Target',
        email: `${targetUserId}@example.com`,
        createdAt: nowIso()
      })
      .execute();
    await db
      .insertInto('extensions')
      .values({
        ext: '102',
        userId: targetUserId,
        ringGroupId: null,
        isParkingSlot: 0
      })
      .execute();
    await db
      .insertInto('devices')
      .values({
        id: newId(),
        userId: targetUserId,
        label: 'phone',
        kind: 'manual',
        sipUsername: 'e102-d1',
        sipPasswordEnc: Buffer.from('secret'),
        createdAt: nowIso()
      })
      .execute();

    const { call, finished } = await startDial('102');
    // The device leg never answers in this test, so the call outlives it; the rejection handler
    // keeps the promise from floating once the fake closes under it.
    finished.catch(() => undefined);
    // The dispatch has reached the extension's user, past any hop it could have counted.
    await eventually(() => {
      expect(call.calleeUserId).toBe(targetUserId);
    });

    expect(call.hops).toBe(0);
  });
});
