import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  newId,
  nowIso,
  openDb,
  type Db,
  type MailRequest
} from '@zamfono/shared';
import { migrateForTest } from '@zamfono/shared/testDb.js';

import { AmiClient } from '../ami/client.js';
import { FakeAmi } from '../ami/fake.js';
import { AriClient } from '../ari/client.js';
import { FakeAri } from '../ari/fake.js';
import { defaultChannel } from '../ari/fakeChannel.js';
import { isPlacement, placedCallerId } from '../ari/fakeDial.js';
import type { AriEvent, Channel } from '../ari/types.js';
import { EventBus } from '../internal/eventBus.js';
import { ConfigCache } from '../internal/snapshot.js';
import { StateStore } from '../internal/stateStore.js';
import { onEvents } from '../testing/busEvents.js';
import { eventually } from '../testing/eventually.js';
import {
  noopCdr,
  noopLogger,
  noopRecorder,
  registerDevice,
  testPipelineDeps
} from '../testing/pipelineDeps.js';
import { newCall, type Call } from './call.js';
import { liveView } from './callState.js';
import { Pipeline, type PipelineDeps } from './pipeline.js';
import { sipToHangupCause } from './releaseCause.js';
import { TrunkState } from './trunkState.js';
import { runUserStep } from './userStep.js';

// The find-me accept window is a real, fixed 5 s (§10.1 step 4); a leg left unaccepted is dropped
// once it elapses, so the wait for that drop runs past it.
const FIND_ME_DROP_WAIT_MS = 6500;

/** Records every `open`/`finish` call, standing in for the real `CdrWriter`. */
function fakeCdr(): PipelineDeps['cdr'] & { opened: Call[]; finished: Call[] } {
  const opened: Call[] = [];
  const finished: Call[] = [];
  return {
    ...noopCdr(),
    opened,
    finished,
    open: call => {
      opened.push(call);
      return Promise.resolve();
    },
    finish: call => {
      finished.push(call);
      return Promise.resolve();
    }
  };
}

async function seedSettings(db: Db, mainDidId: string): Promise<void> {
  await db
    .insertInto('settings')
    .values({
      id: 1,
      companyName: 'Zamfono',
      mainDidId,
      country: 'DE',
      emergencyNumbersJson: '["112"]'
    })
    .execute();
}

async function seedDid(
  db: Db,
  number: string,
  targetId: string
): Promise<string> {
  const id = newId();
  await db
    .insertInto('dids')
    .values({ id, number, targetId, createdAt: nowIso() })
    .execute();
  return id;
}

async function seedForwardTargetUser(db: Db, userId: string): Promise<string> {
  const id = newId();
  await db.insertInto('forwardTargets').values({ id, userId }).execute();
  return id;
}

async function seedTrunkWithRoute(db: Db): Promise<string> {
  const id = newId();
  await db
    .insertInto('trunks')
    .values({
      id,
      name: `trunk-${id}`,
      priority: 1,
      emergency: 1,
      authMode: 'registration',
      username: 'u',
      passwordEnc: Buffer.from('secret'),
      inboundAuth: 0,
      transport: 'udp',
      createdAt: nowIso()
    })
    .execute();
  await db
    .insertInto('trunkHosts')
    .values({
      trunkId: id,
      priority: 1,
      host: 'sip.example.net',
      port: null,
      direction: 'both'
    })
    .execute();
  await db
    .insertInto('outboundRoutes')
    .values({ id: newId(), priority: 1, trunkId: id, createdAt: nowIso() })
    .execute();
  return id;
}

async function seedForwardTargetExternal(
  db: Db,
  number: string
): Promise<string> {
  const id = newId();
  await db
    .insertInto('forwardTargets')
    .values({ id, external: number })
    .execute();
  return id;
}

/** Every `POST /channels/<id>/record` body the fake recorded, for the deposit assertions. */
function recordBodies(fakeAri: FakeAri): { name?: string }[] {
  return fakeAri.calls
    .filter(
      entry =>
        entry.method === 'POST' && /^channels\/.+\/record$/u.test(entry.path)
    )
    .map(entry => entry.body as { name?: string });
}

/**
 * The call the pipeline created for `callerChannel`, once its ring race rings `legCount` legs:
 * the ring spans a config read and one awaited originate per device, so a test that ends the legs
 * itself waits for them to ring rather than guessing how long that takes.
 */
function ringingCall(
  pipeline: Pipeline,
  callerChannel: Channel,
  legCount: number
): Promise<Call> {
  return eventually(() => {
    const call = pipeline.callByChannel.get(callerChannel.id);
    const ringing = [...(call?.legs.values() ?? [])].filter(
      leg => leg.state === 'ringing'
    );
    expect(ringing).toHaveLength(legCount);
    if (call === undefined) {
      throw new Error('no call for the caller channel');
    }
    return call;
  });
}

type UserOverrides = {
  dnd?: boolean;
  mailboxEnabled?: boolean;
  ringTimeoutS?: number;
  findMe?: { number: string; delayS: number }[];
};

async function seedUser(
  db: Db,
  overrides: UserOverrides = {}
): Promise<string> {
  const id = newId();
  await db
    .insertInto('users')
    .values({
      id,
      name: 'Test User',
      email: `${id}@example.com`,
      createdAt: nowIso(),
      dnd: overrides.dnd === true ? 1 : 0,
      mailboxEnabled: overrides.mailboxEnabled === false ? 0 : 1,
      ringTimeoutS: overrides.ringTimeoutS ?? 5,
      findMeJson: overrides.findMe ? JSON.stringify(overrides.findMe) : null
    })
    .execute();
  return id;
}

async function seedDevice(
  db: Db,
  userId: string,
  sipUsername: string
): Promise<void> {
  await db
    .insertInto('devices')
    .values({
      id: newId(),
      userId,
      label: sipUsername,
      kind: 'manual',
      sipUsername,
      sipPasswordEnc: Buffer.from('secret'),
      createdAt: nowIso()
    })
    .execute();
}

async function seedUnconditionalForward(
  db: Db,
  fromUserId: string,
  targetId: string
): Promise<void> {
  await db
    .insertInto('userForwardRules')
    .values({ userId: fromUserId, condition: 'unconditional', targetId })
    .execute();
}

async function seedBusyForward(
  db: Db,
  fromUserId: string,
  targetId: string
): Promise<void> {
  await db
    .insertInto('userForwardRules')
    .values({ userId: fromUserId, condition: 'busy', targetId })
    .execute();
}

/** An always-closed schedule for `scope`: no intervals, so `isOpen` is false at any instant. */
async function seedClosedOpeningHours(
  db: Db,
  scopeUserId: string,
  closedTargetId: string
): Promise<void> {
  await db
    .insertInto('openingHours')
    .values({
      id: newId(),
      scopeUserId,
      closedTargetId,
      createdAt: nowIso()
    })
    .execute();
}

function inboundEvent(channel: Channel, exten: string): AriEvent {
  return {
    type: 'StasisStart',
    timestamp: nowIso(),
    application: 'zamfono',
    args: ['inbound', exten],
    channel
  };
}

describe('Pipeline', () => {
  // eslint-disable-next-line init-declarations -- assigned in beforeEach before each test runs
  let db: Db;
  // eslint-disable-next-line init-declarations -- assigned in beforeEach before each test runs
  let fakeAri: FakeAri;
  // eslint-disable-next-line init-declarations -- assigned in beforeEach before each test runs
  let ari: AriClient;
  // eslint-disable-next-line init-declarations -- assigned in beforeEach before each test runs
  let cdr: PipelineDeps['cdr'] & { opened: Call[]; finished: Call[] };
  // eslint-disable-next-line init-declarations -- assigned in beforeEach before each test runs
  let pipeline: Pipeline;
  let recorderCalls: string[] = [];
  let mailRequests: MailRequest[] = [];
  // eslint-disable-next-line init-declarations -- assigned in beforeEach before each test runs
  let fakeAmi: FakeAmi;
  // eslint-disable-next-line init-declarations -- assigned in beforeEach before each test runs
  let ami: AmiClient;

  beforeEach(async () => {
    db = openDb(':memory:');
    await migrateForTest(db);
    fakeAri = new FakeAri();
    fakeAri.answerAfterMs = 5;
    const { url } = await fakeAri.listen();
    ari = new AriClient({
      url,
      user: 'zamfono',
      password: 'secret',
      app: 'zamfono',
      log: noopLogger
    });
    await ari.connect();
    cdr = fakeCdr();
    recorderCalls = [];
    mailRequests = [];
    fakeAmi = new FakeAmi();
    const amiAddress = await fakeAmi.listen();
    ami = new AmiClient({
      host: amiAddress.host,
      port: amiAddress.port,
      username: 'zamfono',
      password: 'secret',
      log: noopLogger
    });
    await ami.connect();
    const trunkState = new TrunkState({
      log: noopLogger,
      ari,
      ami,
      cache: new ConfigCache(db),
      state: new StateStore(),
      bus: new EventBus(),
      now: nowIso
    });
    pipeline = new Pipeline(
      testPipelineDeps(ari, db, {
        cdr,
        // §3.1 "Mail": a deposit reaches `api` through this client; the stub records the request so
        // the test asserts the deposit completed rather than that a network call happened.
        apiClient: {
          mail: (request: MailRequest) => {
            mailRequests.push(request);
            return Promise.resolve();
          }
        },
        recorder: {
          ...noopRecorder,
          onCallerUp: call => {
            recorderCalls.push(`callerUp:${call.id}`);
            return Promise.resolve();
          },
          onLegUp: (call, leg) => {
            recorderCalls.push(`legUp:${leg.channelId}`);
            return Promise.resolve();
          },
          onTransfereeUp: () => Promise.resolve(),
          onCallerEnded: call => {
            recorderCalls.push(`callerEnded:${call.id}`);
            return Promise.resolve();
          },
          onLegEnded: (call, leg) => {
            recorderCalls.push(`legEnded:${leg.channelId}`);
            return Promise.resolve();
          }
        },
        trunkState
      })
    );
  });

  afterEach(async () => {
    await ami.close();
    await fakeAmi.close();
    await ari.close();
    await fakeAri.close();
    await db.destroy();
  });

  it("deposits a caller in the target user's mailbox, recording them (§10.1 step 4)", async () => {
    const userId = await seedUser(db, { mailboxEnabled: true });
    await seedDevice(db, userId, 'e101-d1');
    const targetId = await seedForwardTargetUser(db, userId);
    const didId = await seedDid(db, '+15551000', targetId);
    await seedSettings(db, didId);
    fakeAri.answerAfterMs = 60_000;
    await registerDevice(fakeAri, pipeline, 'e101-d1');

    const callerChannel = fakeAri.addChannel({
      caller: { number: '+15559999', name: '' }
    });
    const started = pipeline.handleStasisStart(
      inboundEvent(callerChannel, '+15551000')
    );
    const call = await ringingCall(pipeline, callerChannel, 1);
    const AST_CAUSE_USER_BUSY = 17;
    for (const leg of [...call.legs.values()]) {
      fakeAri.emit({
        type: 'ChannelDestroyed',
        timestamp: nowIso(),
        application: 'zamfono',
        channel: defaultChannel({ id: leg.channelId }),
        cause: AST_CAUSE_USER_BUSY
      });
    }
    // The deposit awaits Asterisk's `RecordingFinished` for its own recording (§10.2); the fake
    // never fires it on its own, so the test plays Asterisk's part once the record call lands.
    const depositName = await eventually(() => {
      const body = recordBodies(fakeAri).at(0);
      expect(body?.name).toBeDefined();
      return body?.name;
    });
    fakeAri.emit({
      type: 'RecordingFinished',
      timestamp: nowIso(),
      application: 'zamfono',
      recording: { name: depositName, duration: 3 }
    });
    await started;

    // §10.2 "Voicemail": the deposit records the caller into media/voicemail/ and marks the call
    // `voicemail`. Answering and hanging up without a recording is not a deposit.
    const names = recordBodies(fakeAri).map(body => body.name ?? '');
    expect(names.some(name => name.startsWith('voicemail/'))).toBe(true);
    expect(call.status).toBe('voicemail');
  });

  it('dials a forward target of kind external instead of releasing it (§10.1 step 7)', async () => {
    const trunkId = await seedTrunkWithRoute(db);
    const externalTargetId = await seedForwardTargetExternal(db, '+15557777');
    const didId = await seedDid(db, '+15551000', externalTargetId);
    await seedSettings(db, didId);
    fakeAri.answerAfterMs = 60_000;

    const callerChannel = fakeAri.addChannel({
      caller: { number: '+15559999', name: '' }
    });
    const started = pipeline.handleStasisStart(
      inboundEvent(callerChannel, '+15551000')
    );

    // §10.1 step 7 with §9.4: the target is dialled over the matching route's trunk, not released.
    await eventually(() => {
      const dialled = fakeAri.calls.filter(entry => isPlacement(entry));
      expect(
        dialled.some(entry =>
          (entry.body as { endpoint?: string }).endpoint?.includes(
            `PJSIP/+15557777@trunk-${trunkId}`
          )
        )
      ).toBe(true);
    });
    // The dialled trunk leg never answers in this test, so the call outlives the assertion; the
    // rejection handler keeps the promise from floating.
    started.catch(() => undefined);
  });

  it("sets the caller channel's language from the tenant setting (§9.1)", async () => {
    const userId = await seedUser(db);
    await seedDevice(db, userId, 'e101-d1');
    const targetId = await seedForwardTargetUser(db, userId);
    const didId = await seedDid(db, '+15551000', targetId);
    await seedSettings(db, didId);
    await registerDevice(fakeAri, pipeline, 'e101-d1');
    await db.updateTable('settings').set({ language: 'de' }).execute();

    const callerChannel = fakeAri.addChannel({
      caller: { number: '+15559999', name: '' }
    });
    await pipeline.handleStasisStart(inboundEvent(callerChannel, '+15551000'));

    // Asterisk resolves a `sound:` name's language variant from the channel's own language, so
    // every default prompt this call plays follows the tenant's setting.
    const setVars = fakeAri.calls.filter(
      entry =>
        entry.method === 'POST' &&
        entry.path === `channels/${callerChannel.id}/variable`
    );
    expect(setVars.map(entry => entry.body)).toContainEqual({
      variable: 'CHANNEL(language)',
      value: 'de'
    });
  });

  it('notifies a user who wants to hear about a call they missed (§10.2 "Mail")', async () => {
    // No mailbox, so the unanswered ring releases the call as `missed` rather than depositing it.
    const userId = await seedUser(db, { mailboxEnabled: false });
    await db
      .updateTable('users')
      .set({ notifyMissedCalls: 1 })
      .where('id', '=', userId)
      .execute();
    await seedDevice(db, userId, 'e101-d1');
    const targetId = await seedForwardTargetUser(db, userId);
    const didId = await seedDid(db, '+15551000', targetId);
    await seedSettings(db, didId);
    fakeAri.answerAfterMs = 60_000;
    await registerDevice(fakeAri, pipeline, 'e101-d1');

    const callerChannel = fakeAri.addChannel({
      caller: { number: '+15559999', name: '' }
    });
    const started = pipeline.handleStasisStart(
      inboundEvent(callerChannel, '+15551000')
    );
    const call = await ringingCall(pipeline, callerChannel, 1);
    for (const leg of [...call.legs.values()]) {
      fakeAri.emit({
        type: 'ChannelDestroyed',
        timestamp: nowIso(),
        application: 'zamfono',
        channel: defaultChannel({ id: leg.channelId }),
        cause: 19
      });
    }
    await started;

    const missed = mailRequests.filter(
      request => request.kind === 'missedCall'
    );
    expect(missed).toHaveLength(1);
    expect(missed[0]?.to).toEqual({ userId });
    // §7: the call's id travels with the request, for the log lines of its send.
    expect(missed[0]?.callId).toBe(call.id);
  });

  // §10.2 "Mail": "one per missed inbound call"; a colleague's unanswered call sends none.
  it.each([
    { direction: 'inbound' as const, mails: 1, sends: 'sends a' },
    { direction: 'internal' as const, mails: 0, sends: 'sends no' }
  ])(
    '$sends missed-call mail for a missed $direction call',
    async ({ direction, mails }) => {
      // No device and no mailbox: the offline default releases the call as missed at once.
      const userId = await seedUser(db, { mailboxEnabled: false });
      await db
        .updateTable('users')
        .set({ notifyMissedCalls: 1 })
        .where('id', '=', userId)
        .execute();
      const targetId = await seedForwardTargetUser(db, userId);
      const didId = await seedDid(db, '+15551000', targetId);
      await seedSettings(db, didId);
      const callerChannel = fakeAri.addChannel({
        caller: { number: '+15559999', name: '' }
      });
      const call = newCall({
        id: newId(),
        direction,
        callerChannelId: callerChannel.id,
        from: '+15559999',
        to: '101',
        startedAt: nowIso(),
        logLevel: 'events',
        callLogMaxBytes: 1_048_576
      });
      call.calleeUserId = userId;
      pipeline.registerCall(call);

      await runUserStep(
        pipeline,
        call,
        await pipeline.deps.cache.get(),
        userId
      );

      expect(call.status).toBe('missed');
      expect(
        mailRequests.filter(request => request.kind === 'missedCall')
      ).toHaveLength(mails);
    }
  );

  it('publishes call.state and the live view as a call rings, answers and ends (§10.6, §3.1)', async () => {
    const seen: string[] = [];
    onEvents(pipeline.deps.bus, envelope => {
      if (envelope.type === 'call.state') {
        seen.push(envelope.state);
      }
    });
    const userId = await seedUser(db);
    await seedDevice(db, userId, 'e101-d1');
    const targetId = await seedForwardTargetUser(db, userId);
    const didId = await seedDid(db, '+15551000', targetId);
    await seedSettings(db, didId);
    await registerDevice(fakeAri, pipeline, 'e101-d1');

    const callerChannel = fakeAri.addChannel({
      caller: { number: '+15559999', name: '' }
    });
    await pipeline.handleStasisStart(inboundEvent(callerChannel, '+15551000'));
    const call = pipeline.callByChannel.get(callerChannel.id);

    expect(seen).toContain('ringing');
    expect(seen).toContain('up');
    // While up, the call is in the live view `GET /internal/state` serves.
    const live = pipeline.deps.state.calls.get(call?.id ?? '');
    expect(live?.state).toBe('up');
    expect(liveView(live ?? expect.unreachable()).userIds).toContain(userId);
  });

  it('hands the answered participation to the recorder (§10.2 "Call recording")', async () => {
    const userId = await seedUser(db);
    await seedDevice(db, userId, 'e101-d1');
    const targetId = await seedForwardTargetUser(db, userId);
    const didId = await seedDid(db, '+15551000', targetId);
    await seedSettings(db, didId);
    await registerDevice(fakeAri, pipeline, 'e101-d1');

    const callerChannel = fakeAri.addChannel({
      caller: { number: '+15559999', name: '' }
    });
    await pipeline.handleStasisStart(inboundEvent(callerChannel, '+15551000'));

    const call = pipeline.callByChannel.get(callerChannel.id);
    const answered = [...(call?.legs.values() ?? [])].find(
      leg => leg.state === 'up'
    );
    expect(answered).toBeDefined();
    expect(recorderCalls).toContain(`legUp:${answered?.channelId ?? ''}`);
    expect(recorderCalls).toContain(`callerUp:${call?.id ?? ''}`);
  });

  it('rings every registered device, answers on first Up, bridges both, hangs up the other leg', async () => {
    const userId = await seedUser(db);
    await seedDevice(db, userId, 'e101-d1');
    await seedDevice(db, userId, 'e101-d2');
    const targetId = await seedForwardTargetUser(db, userId);
    const didId = await seedDid(db, '+15551000', targetId);
    await seedSettings(db, didId);
    await registerDevice(fakeAri, pipeline, 'e101-d1');
    await registerDevice(fakeAri, pipeline, 'e101-d2');

    const callerChannel = fakeAri.addChannel({
      caller: { number: '+15559999', name: '' }
    });
    await pipeline.handleStasisStart(inboundEvent(callerChannel, '+15551000'));

    const originates = fakeAri.calls.filter(entry => isPlacement(entry));
    expect(originates).toHaveLength(2);

    const call = pipeline.callByChannel.get(callerChannel.id);
    const wantedAppArgs = `leg,${call?.id}`;
    expect(
      originates.every(
        entry => (entry.body as { appArgs?: string }).appArgs === wantedAppArgs
      )
    ).toBe(true);
    expect(call?.status).toBe('answered');
    expect(call?.bridgeId).not.toBeNull();
    const legs = [...(call?.legs.values() ?? [])];
    expect(legs.filter(leg => leg.state === 'up')).toHaveLength(1);
    expect(legs.filter(leg => leg.state === 'ended')).toHaveLength(1);

    const answered = fakeAri.calls.some(
      entry =>
        entry.method === 'POST' &&
        entry.path === `channels/${callerChannel.id}/answer`
    );
    expect(answered).toBe(true);
    const bridgeCreated = fakeAri.calls.some(
      entry => entry.method === 'POST' && entry.path === 'bridges'
    );
    expect(bridgeCreated).toBe(true);
    const winner = legs.find(leg => leg.state === 'up');
    const addedChannels = fakeAri.calls
      .filter(
        entry =>
          entry.method === 'POST' &&
          entry.path === `bridges/${call?.bridgeId}/addChannel`
      )
      .map(entry => (entry.body as { channel?: string }).channel);
    expect(addedChannels).toEqual(
      expect.arrayContaining([callerChannel.id, winner?.channelId])
    );
    // A loser that answers while the winner is being bridged is ended at once and hung up
    // without the ring waiting for it, so its hangup may land just after the call resolves.
    await eventually(() => {
      const loserHungUp = fakeAri.calls.some(
        entry =>
          entry.method === 'DELETE' &&
          legs.some(
            leg =>
              leg.state === 'ended' &&
              entry.path === `channels/${leg.channelId}`
          )
      );
      expect(loserHungUp).toBe(true);
    });
  });

  it("names a phone-book caller on the device legs: the contact's display name is the caller-ID name (§10.2)", async () => {
    const contactId = newId();
    await db
      .insertInto('contacts')
      .values({
        id: contactId,
        displayName: 'Huber "GmbH"',
        createdAt: nowIso(),
        updatedAt: nowIso()
      })
      .execute();
    await db
      .insertInto('contactPhones')
      .values({ contactId, number: '+15559999', label: 'office' })
      .execute();
    const userId = await seedUser(db);
    await seedDevice(db, userId, 'e101-d1');
    const targetId = await seedForwardTargetUser(db, userId);
    const didId = await seedDid(db, '+15551000', targetId);
    await seedSettings(db, didId);
    await registerDevice(fakeAri, pipeline, 'e101-d1');

    const known = fakeAri.addChannel({
      caller: { number: '+15559999', name: '' }
    });
    await pipeline.handleStasisStart(inboundEvent(known, '+15551000'));

    const callerIds = fakeAri.calls
      .filter(entry => isPlacement(entry))
      .map(entry => placedCallerId(entry));
    // The quote would end the quoted name early, so it is dropped.
    expect(callerIds).toEqual(['"Huber GmbH" <+15559999>']);
  });

  it('releases a blocked caller with cause 603 and records it as blocked', async () => {
    const userId = await seedUser(db);
    const targetId = await seedForwardTargetUser(db, userId);
    const didId = await seedDid(db, '+15551000', targetId);
    await seedSettings(db, didId);
    await db
      .insertInto('blockedNumbers')
      .values({ id: newId(), number: '+15559999', createdAt: nowIso() })
      .execute();

    const callerChannel = fakeAri.addChannel({
      caller: { number: '+15559999', name: '' }
    });
    await pipeline.handleStasisStart(inboundEvent(callerChannel, '+15551000'));

    const call = pipeline.callByChannel.get(callerChannel.id);
    expect(call?.status).toBe('blocked');
    const hungUp = fakeAri.calls.find(
      entry =>
        entry.method === 'DELETE' &&
        entry.path === `channels/${callerChannel.id}`
    );
    expect(hungUp?.qs).toBe(`reason_code=${sipToHangupCause(603)}`);
    expect(cdr.finished).toContain(call);
    const originated = fakeAri.calls.some(entry => isPlacement(entry));
    expect(originated).toBe(false);
  });

  it('applies an in-effect OOO rule instead of ringing the target', async () => {
    const offlineUserId = await seedUser(db, { mailboxEnabled: false });
    const offlineTargetId = await seedForwardTargetUser(db, offlineUserId);

    const primaryUserId = await seedUser(db);
    await seedDevice(db, primaryUserId, 'e101-d1');
    const primaryTargetId = await seedForwardTargetUser(db, primaryUserId);
    const didId = await seedDid(db, '+15551000', primaryTargetId);
    await seedSettings(db, didId);
    await registerDevice(fakeAri, pipeline, 'e101-d1');
    await db
      .insertInto('oooRules')
      .values({
        id: newId(),
        scopeUserId: primaryUserId,
        active: 1,
        targetId: offlineTargetId,
        createdAt: nowIso()
      })
      .execute();

    const callerChannel = fakeAri.addChannel({
      caller: { number: '+15559999', name: '' }
    });
    await pipeline.handleStasisStart(inboundEvent(callerChannel, '+15551000'));

    const call = pipeline.callByChannel.get(callerChannel.id);
    expect(call?.status).toBe('missed');
    expect(call?.calleeUserId).toBe(offlineUserId);
    const originated = fakeAri.calls.some(entry => isPlacement(entry));
    expect(originated).toBe(false);
  });

  it('applies the closed target of an always-closed opening-hours schedule instead of ringing', async () => {
    const closedUserId = await seedUser(db, { mailboxEnabled: false });
    const closedTargetId = await seedForwardTargetUser(db, closedUserId);

    const primaryUserId = await seedUser(db);
    await seedDevice(db, primaryUserId, 'e101-d1');
    const primaryTargetId = await seedForwardTargetUser(db, primaryUserId);
    const didId = await seedDid(db, '+15551000', primaryTargetId);
    await seedSettings(db, didId);
    await registerDevice(fakeAri, pipeline, 'e101-d1');
    await seedClosedOpeningHours(db, primaryUserId, closedTargetId);

    const callerChannel = fakeAri.addChannel({
      caller: { number: '+15559999', name: '' }
    });
    await pipeline.handleStasisStart(inboundEvent(callerChannel, '+15551000'));

    const call = pipeline.callByChannel.get(callerChannel.id);
    expect(call?.status).toBe('missed');
    expect(call?.calleeUserId).toBe(closedUserId);
    const originated = fakeAri.calls.some(entry => isPlacement(entry));
    expect(originated).toBe(false);
  });

  it('ends a chain of three forward hops at the last target when the fourth would exceed the limit', async () => {
    const u4 = await seedUser(db, { mailboxEnabled: false });
    const u4Target = await seedForwardTargetUser(db, u4);
    const u3 = await seedUser(db);
    const u3Target = await seedForwardTargetUser(db, u3);
    await seedUnconditionalForward(db, u3, u4Target);
    const u2 = await seedUser(db);
    const u2Target = await seedForwardTargetUser(db, u2);
    await seedUnconditionalForward(db, u2, u3Target);
    const u1 = await seedUser(db);
    const u1Target = await seedForwardTargetUser(db, u1);
    await seedUnconditionalForward(db, u1, u2Target);
    // u4 forwards unconditionally too, which would be the fourth hop.
    const u5 = await seedUser(db);
    const u5Target = await seedForwardTargetUser(db, u5);
    await seedUnconditionalForward(db, u4, u5Target);

    const didId = await seedDid(db, '+15551000', u1Target);
    await seedSettings(db, didId);

    const callerChannel = fakeAri.addChannel({
      caller: { number: '+15559999', name: '' }
    });
    await pipeline.handleStasisStart(inboundEvent(callerChannel, '+15551000'));

    const call = pipeline.callByChannel.get(callerChannel.id);
    expect(call?.calleeUserId).toBe(u4);
    expect(call?.status).toBe('missed');
    const hungUp = fakeAri.calls.some(
      entry =>
        entry.method === 'DELETE' &&
        entry.path === `channels/${callerChannel.id}`
    );
    expect(hungUp).toBe(true);
  });

  it('drops a find-me leg not accepted with DTMF 1 within the accept window', async () => {
    // Find-me legs go out through the normal outbound resolution (§10.1 step 4), so a route must carry them.
    await seedTrunkWithRoute(db);
    const userId = await seedUser(db, {
      ringTimeoutS: 6,
      findMe: [{ number: '+15557000', delayS: 0 }]
    });
    const targetId = await seedForwardTargetUser(db, userId);
    const didId = await seedDid(db, '+15551000', targetId);
    await seedSettings(db, didId);

    const callerChannel = fakeAri.addChannel({
      caller: { number: '+15559999', name: '' }
    });
    pipeline
      .handleStasisStart(inboundEvent(callerChannel, '+15551000'))
      .catch(() => undefined);

    const call = await ringingCall(pipeline, callerChannel, 1);
    const leg = [...call.legs.values()].find(entry => entry.kind === 'findMe');
    expect(leg).toBeDefined();
    if (!leg) {
      return;
    }

    // The drop ends the leg at once and then hangs its channel up, one round trip later.
    await eventually(() => {
      expect(leg.state).toBe('ended');
      const droppedHangup = fakeAri.calls.some(
        entry =>
          entry.method === 'DELETE' &&
          entry.path === `channels/${leg.channelId}`
      );
      expect(droppedHangup).toBe(true);
    }, FIND_ME_DROP_WAIT_MS);
    expect(call.status).not.toBe('answered');
    // Real 5 s find-me accept window (§10.1 step 4, fixed) plus the overall ring race.
  }, 8000);

  it('applies the busy rule once every device leg has declined busy, ending the ring race early', async () => {
    const busyUserId = await seedUser(db, { mailboxEnabled: false });
    const busyTargetId = await seedForwardTargetUser(db, busyUserId);
    const userId = await seedUser(db, { ringTimeoutS: 30 });
    await seedDevice(db, userId, 'e101-d1');
    await seedDevice(db, userId, 'e101-d2');
    await seedBusyForward(db, userId, busyTargetId);
    const targetId = await seedForwardTargetUser(db, userId);
    const didId = await seedDid(db, '+15551000', targetId);
    await seedSettings(db, didId);
    fakeAri.answerAfterMs = 60_000;
    await registerDevice(fakeAri, pipeline, 'e101-d1');
    await registerDevice(fakeAri, pipeline, 'e101-d2');
    // The test declines both legs itself before this fires.

    const callerChannel = fakeAri.addChannel({
      caller: { number: '+15559999', name: '' }
    });
    const started = pipeline.handleStasisStart(
      inboundEvent(callerChannel, '+15551000')
    );
    const call = await ringingCall(pipeline, callerChannel, 2);
    const deviceLegs = [...call.legs.values()];
    const AST_CAUSE_USER_BUSY = 17;
    for (const leg of deviceLegs) {
      // Asterisk fires `StasisEnd` (no cause) before `ChannelDestroyed` (the real Q.850 cause)
      // for a channel that was in the Stasis app; only the latter should end the leg.
      fakeAri.emit({
        type: 'StasisEnd',
        timestamp: nowIso(),
        application: 'zamfono',
        channel: defaultChannel({ id: leg.channelId })
      });
      fakeAri.emit({
        type: 'ChannelDestroyed',
        timestamp: nowIso(),
        application: 'zamfono',
        channel: defaultChannel({ id: leg.channelId }),
        cause: AST_CAUSE_USER_BUSY
      });
    }
    await started;

    expect(call.calleeUserId).toBe(busyUserId);
    expect(call.status).toBe('missed');
    const declinedLines = call.log
      .finish()
      .log?.split('\n')
      .filter(
        line => (JSON.parse(line) as { event?: string }).event === 'declined'
      );
    expect(declinedLines).toHaveLength(2);
  });

  it('applies the busy rule when the only device declines busy before its originate returns', async () => {
    const busyUserId = await seedUser(db, { mailboxEnabled: false });
    const busyTargetId = await seedForwardTargetUser(db, busyUserId);
    const userId = await seedUser(db, { ringTimeoutS: 30 });
    await seedDevice(db, userId, 'e101-d1');
    await seedBusyForward(db, userId, busyTargetId);
    const targetId = await seedForwardTargetUser(db, userId);
    const didId = await seedDid(db, '+15551000', targetId);
    await seedSettings(db, didId);
    fakeAri.answerAfterMs = 60_000;
    await registerDevice(fakeAri, pipeline, 'e101-d1');
    // Asterisk dials the device while it answers the originate; a phone that answers 486 at once
    // has the channel destroyed before the core learns its id.
    fakeAri.onOriginate = channel => {
      fakeAri.onOriginate = null;
      fakeAri.emit({
        type: 'ChannelDestroyed',
        timestamp: nowIso(),
        application: 'zamfono',
        channel: defaultChannel({ id: channel.id }),
        cause: 17
      });
    };

    const callerChannel = fakeAri.addChannel({
      caller: { number: '+15559999', name: '' }
    });
    const started = pipeline.handleStasisStart(
      inboundEvent(callerChannel, '+15551000')
    );
    await started;

    const call = cdr.opened.at(0);
    expect(call?.calleeUserId).toBe(busyUserId);
    expect(call?.status).toBe('missed');
  });

  it('abandoning the call while ringing cancels the race and finishes the call', async () => {
    const userId = await seedUser(db, { ringTimeoutS: 30 });
    await seedDevice(db, userId, 'e101-d1');
    const targetId = await seedForwardTargetUser(db, userId);
    const didId = await seedDid(db, '+15551000', targetId);
    await seedSettings(db, didId);
    fakeAri.answerAfterMs = 60_000;
    await registerDevice(fakeAri, pipeline, 'e101-d1');
    // The test abandons the call itself before this fires.

    const callerChannel = fakeAri.addChannel({
      caller: { number: '+15559999', name: '' }
    });
    const started = pipeline.handleStasisStart(
      inboundEvent(callerChannel, '+15551000')
    );
    const call = await ringingCall(pipeline, callerChannel, 1);
    const leg = [...call.legs.values()].at(0);
    expect(leg).toBeDefined();
    if (!leg) {
      return;
    }
    expect(leg.state).toBe('ringing');

    fakeAri.emit({
      type: 'ChannelDestroyed',
      timestamp: nowIso(),
      application: 'zamfono',
      channel: defaultChannel({ id: callerChannel.id })
    });
    await started;

    expect(call.status).toBe('missed');
    expect(cdr.finished).toContain(call);
    expect(leg.state).toBe('ended');
    const legHungUp = fakeAri.calls.some(
      entry =>
        entry.method === 'DELETE' && entry.path === `channels/${leg.channelId}`
    );
    expect(legHungUp).toBe(true);
  });
});
