import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { newId, nowIso, openDb, type Db } from '@zamfono/shared';
import { migrateForTest } from '@zamfono/shared/testDb.js';

import { AmiClient } from '../ami/client.js';
import { AriClient } from '../ari/client.js';
import { FakeAri, isPlacement, placedCallerId } from '../ari/fake.js';
import { defaultChannel, type Channel, type Logger } from '../ari/types.js';
import { eventually } from '../testing/eventually.js';
import { newCall, type Call } from './call.js';
import { enterTarget } from './inbound.js';
import { playMenu } from './menu.js';
import { dispatchAction } from './outboundDispatch.js';
import {
  ConfigCache,
  EventBus,
  Pipeline,
  StateStore,
  type PipelineDeps
} from './pipeline.js';
import { sipToHangupCause } from './releaseCause.js';
import { ringGroup } from './ringGroup.js';
import { TrunkState } from './trunkState.js';

// §10.1 step 7 with §9.4 "Outbound routing": an external forward target is dialled "as the
// forwarding user's call, or without a caller when a DID, menu, ring group or tenant rule
// forwards" — route caller lists, presented number and CLIR are the forwarder's, never those of
// the caller whose call is being forwarded.

const noopLogger: Logger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined
};

// Q.850 17, user busy (SIP 486), as ARI's `ChannelDestroyed` carries it.
const AST_CAUSE_USER_BUSY = 17;
const MAIN_NUMBER = '+491110000';
const FORWARD_NUMBER = '+15557777';

function fakeCdr(): PipelineDeps['cdr'] {
  return { open: () => Promise.resolve(), finish: () => Promise.resolve() };
}

async function seedTarget(
  db: Db,
  values: { external?: string; userId?: string }
): Promise<string> {
  const id = newId();
  await db
    .insertInto('forwardTargets')
    .values({ id, ...values })
    .execute();
  return id;
}

async function seedDid(
  db: Db,
  number: string,
  targetId?: string
): Promise<string> {
  const id = newId();
  await db
    .insertInto('dids')
    .values({
      id,
      number,
      targetId: targetId ?? (await seedTarget(db, { external: '+15550000' })),
      createdAt: nowIso()
    })
    .execute();
  return id;
}

async function seedSettings(db: Db): Promise<void> {
  const mainDidId = await seedDid(db, MAIN_NUMBER);
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

/** A user presenting `number` as their own DID, with `clir` as their CLIR level. */
async function seedUser(
  db: Db,
  opts: { number?: string; clir?: 0 | 1 } = {}
): Promise<string> {
  const calleridDidId =
    opts.number === undefined ? null : await seedDid(db, opts.number);
  const id = newId();
  await db
    .insertInto('users')
    .values({
      id,
      name: 'User',
      email: `${id}@example.com`,
      createdAt: nowIso(),
      mailboxEnabled: 0,
      ringTimeoutS: 30,
      calleridDidId,
      clir: opts.clir ?? null
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

/** A `registration` trunk whose one route admits `onlyUserId` alone, or every caller when `null`. */
async function seedTrunkRoute(
  db: Db,
  priority: number,
  onlyUserId: string | null,
  calleridHeader: 'from' | 'both' = 'from'
): Promise<string> {
  const trunkId = newId();
  await db
    .insertInto('trunks')
    .values({
      id: trunkId,
      name: `trunk-${priority}`,
      priority,
      emergency: 1,
      authMode: 'registration',
      username: `user${priority}`,
      passwordEnc: Buffer.from('secret'),
      inboundAuth: 0,
      transport: 'udp',
      calleridHeader,
      createdAt: nowIso()
    })
    .execute();
  await db
    .insertInto('trunkHosts')
    .values({
      trunkId,
      priority: 1,
      host: `sip${priority}.example.com`,
      port: null,
      direction: 'both'
    })
    .execute();
  const routeId = newId();
  await db
    .insertInto('outboundRoutes')
    .values({ id: routeId, priority, trunkId, createdAt: nowIso() })
    .execute();
  if (onlyUserId !== null) {
    await db
      .insertInto('outboundRouteUsers')
      .values({ routeId, userId: onlyUserId })
      .execute();
  }
  return trunkId;
}

async function seedUserRule(
  db: Db,
  userId: string,
  condition: 'unconditional' | 'busy' | 'offline'
): Promise<void> {
  const targetId = await seedTarget(db, { external: FORWARD_NUMBER });
  await db
    .insertInto('userForwardRules')
    .values({ userId, condition, targetId })
    .execute();
}

/** An active OOO rule forwarding to the external number: `userId`'s own, or the tenant's. */
async function seedOoo(db: Db, userId: string | null): Promise<void> {
  await db
    .insertInto('oooRules')
    .values({
      id: newId(),
      scopeUserId: userId,
      active: 1,
      targetId: await seedTarget(db, { external: FORWARD_NUMBER }),
      createdAt: nowIso()
    })
    .execute();
}

type Originate = {
  endpoint: string;
  callerId?: string;
  variables?: Record<string, string>;
};

function trunkOriginates(fakeAri: FakeAri): Originate[] {
  return fakeAri.calls
    .filter(entry => isPlacement(entry))
    .map(entry => ({
      ...(entry.body as Originate),
      callerId: placedCallerId(entry)
    }))
    .filter(body => body.endpoint.includes('@trunk-'));
}

describe('an external forward target is dialled as the forwarding user (§10.1 step 7, §9.4)', () => {
  // eslint-disable-next-line init-declarations -- assigned in beforeEach before each test runs
  let db: Db;
  // eslint-disable-next-line init-declarations -- assigned in beforeEach before each test runs
  let fakeAri: FakeAri;
  // eslint-disable-next-line init-declarations -- assigned in beforeEach before each test runs
  let ari: AriClient;
  // eslint-disable-next-line init-declarations -- assigned in beforeEach before each test runs
  let pipeline: Pipeline;
  // eslint-disable-next-line init-declarations -- assigned in beforeEach before each test runs
  let callerChannel: Channel;
  // eslint-disable-next-line init-declarations -- assigned in beforeEach before each test runs
  let caller: string;
  // eslint-disable-next-line init-declarations -- assigned in beforeEach before each test runs
  let call: Call;

  /** A call from `caller` (or from outside, `null`), still ringing, whose promise never floats. */
  function newCallFrom(
    callerUserId: string | null,
    direction: Call['direction'] = 'internal'
  ): Call {
    const fresh = newCall({
      id: newId(),
      direction,
      callerChannelId: callerChannel.id,
      from: callerUserId === null ? '+15559999' : '101',
      to: '102',
      startedAt: nowIso(),
      logLevel: 'events',
      callLogMaxBytes: 1_048_576
    });
    fresh.callerUserId = callerUserId;
    pipeline.registerCall(fresh);
    return fresh;
  }

  /** Lets `started` run until its trunk leg is originated; the leg never answers in these tests. */
  function dialled(started: Promise<void>): Promise<Originate[]> {
    started.catch(() => undefined);
    return eventually(() => {
      const legs = trunkOriginates(fakeAri);
      expect(legs).not.toHaveLength(0);
      return legs;
    });
  }

  beforeEach(async () => {
    db = openDb(':memory:');
    await migrateForTest(db);
    await seedSettings(db);
    fakeAri = new FakeAri();
    fakeAri.answerAfterMs = 60_000;
    const { url } = await fakeAri.listen();
    ari = new AriClient({
      url,
      user: 'zamfono',
      password: 'secret',
      app: 'zamfono',
      log: noopLogger
    });
    await ari.connect();
    const state = new StateStore();
    const trunkState = new TrunkState({
      ari,
      ami: new AmiClient({
        host: '127.0.0.1',
        port: 1,
        username: 'zamfono',
        password: 'secret',
        log: noopLogger
      }),
      cache: new ConfigCache(db),
      state,
      bus: new EventBus(),
      now: nowIso
    });
    pipeline = new Pipeline({
      ari,
      cache: new ConfigCache(db),
      state,
      bus: new EventBus(),
      cdr: fakeCdr(),
      now: nowIso,
      trunkState,
      presence: null
    });
    callerChannel = fakeAri.addChannel({
      caller: { number: '101', name: '' }
    });
    // The caller has a number, a CLIR level and a route of their own, all unlike the forwarder's.
    caller = await seedUser(db, { number: '+491110101', clir: 0 });
    call = newCallFrom(caller);
  });

  afterEach(async () => {
    await ari.close();
    await fakeAri.close();
    await db.destroy();
  });

  describe("a user's own forward", () => {
    it("an unconditional forward leaves over the forwarder's route with their number, not the caller's", async () => {
      const forwarder = await seedUser(db, { number: '+491110202' });
      await seedUserRule(db, forwarder, 'unconditional');
      await seedTrunkRoute(db, 1, caller);
      const forwarderTrunk = await seedTrunkRoute(db, 2, forwarder);

      const legs = await dialled(
        enterTarget(
          pipeline,
          call,
          { id: '', kind: 'user', userId: forwarder },
          null
        )
      );

      expect(legs.map(leg => leg.endpoint)).toEqual([
        `PJSIP/${FORWARD_NUMBER}@trunk-${forwarderTrunk}`
      ]);
      expect(legs.at(0)?.callerId).toBe('+491110202');
    });

    // §10.3 "Users": a user writes their own external rule, which nothing checks against their
    // routes on write; the forward is refused at call time as their own dial would be, with 503
    // and a `noRoute` trace line (§9.4 "Outbound routing"), even where the caller has a route.
    it("refuses a forward to a number the forwarder's routes do not carry, though the caller's do", async () => {
      const forwarder = await seedUser(db, { number: '+491110202' });
      await seedUserRule(db, forwarder, 'unconditional');
      await seedTrunkRoute(db, 1, caller);

      await enterTarget(
        pipeline,
        call,
        { id: '', kind: 'user', userId: forwarder },
        null
      );

      expect(trunkOriginates(fakeAri)).toEqual([]);
      expect(call.status).toBe('failed');
      const release = fakeAri.calls.find(
        entry =>
          entry.method === 'DELETE' &&
          entry.path === `channels/${callerChannel.id}`
      );
      expect(release?.qs).toBe(`reason_code=${sipToHangupCause(503)}`);
      const events = (call.log.finish().log ?? '')
        .split('\n')
        .filter(Boolean)
        .map(line => String((JSON.parse(line) as { event?: string }).event));
      expect(events).toContain('noRoute');
    });

    it("withholds the number under the forwarder's CLIR though the caller shows theirs", async () => {
      const forwarder = await seedUser(db, { number: '+491110202', clir: 1 });
      await seedUserRule(db, forwarder, 'unconditional');
      await seedTrunkRoute(db, 1, null, 'both');

      const legs = await dialled(
        enterTarget(
          pipeline,
          call,
          { id: '', kind: 'user', userId: forwarder },
          null
        )
      );

      expect(legs).toHaveLength(1);
      expect(legs.at(0)?.variables?.['CONNECTEDLINE(pres)']).toBe('prohib');
      expect(legs.at(0)?.callerId).toBe('+491110202');
    });

    it("shows the forwarder's number when the caller withholds theirs", async () => {
      const withholding = await seedUser(db, { number: '+491110303', clir: 1 });
      const forwarder = await seedUser(db, { number: '+491110202', clir: 0 });
      await seedUserRule(db, forwarder, 'unconditional');
      await seedTrunkRoute(db, 1, null, 'both');

      const legs = await dialled(
        enterTarget(
          pipeline,
          newCallFrom(withholding),
          { id: '', kind: 'user', userId: forwarder },
          null
        )
      );

      expect(legs).toHaveLength(1);
      expect(legs.at(0)?.variables?.['CONNECTEDLINE(pres)']).toBe(undefined);
      expect(legs.at(0)?.variables?.['CALLERID(num)']).toBe('+491110202');
    });

    it("an offline forward is the forwarder's call", async () => {
      const forwarder = await seedUser(db, { number: '+491110202' });
      await seedUserRule(db, forwarder, 'offline');
      await seedTrunkRoute(db, 1, caller);
      const forwarderTrunk = await seedTrunkRoute(db, 2, forwarder);

      const legs = await dialled(
        enterTarget(
          pipeline,
          call,
          { id: '', kind: 'user', userId: forwarder },
          null
        )
      );

      expect(legs.map(leg => leg.endpoint)).toEqual([
        `PJSIP/${FORWARD_NUMBER}@trunk-${forwarderTrunk}`
      ]);
    });

    it("a busy forward, applied once the forwarder's device answers 486, is the forwarder's call", async () => {
      const forwarder = await seedUser(db, { number: '+491110202' });
      await seedDevice(db, forwarder, 'e102-d1');
      await seedUserRule(db, forwarder, 'busy');
      await seedTrunkRoute(db, 1, caller);
      const forwarderTrunk = await seedTrunkRoute(db, 2, forwarder);

      const started = enterTarget(
        pipeline,
        call,
        { id: '', kind: 'user', userId: forwarder },
        null
      );
      started.catch(() => undefined);
      // The device leg, once the ring race holds it, so its 486 reaches the race.
      const device = await eventually(async () => {
        const found = (await ari.channels.list()).find(
          entry => entry.name === 'PJSIP/e102-d1'
        );
        expect(call.legs.has(found?.id ?? '')).toBe(true);
        return found;
      });
      fakeAri.emit({
        type: 'ChannelDestroyed',
        timestamp: nowIso(),
        application: 'zamfono',
        channel: defaultChannel({ id: device?.id ?? '', state: 'Down' }),
        cause: AST_CAUSE_USER_BUSY
      });
      const legs = await dialled(started);

      expect(legs.map(leg => leg.endpoint)).toEqual([
        `PJSIP/${FORWARD_NUMBER}@trunk-${forwarderTrunk}`
      ]);
      expect(legs.at(0)?.callerId).toBe('+491110202');
    });

    it("the forwarder's own OOO rule is the forwarder's call", async () => {
      const forwarder = await seedUser(db, { number: '+491110202' });
      await seedOoo(db, forwarder);
      await seedTrunkRoute(db, 1, caller);
      const forwarderTrunk = await seedTrunkRoute(db, 2, forwarder);

      const legs = await dialled(
        enterTarget(
          pipeline,
          call,
          { id: '', kind: 'user', userId: forwarder },
          null
        )
      );

      expect(legs.map(leg => leg.endpoint)).toEqual([
        `PJSIP/${FORWARD_NUMBER}@trunk-${forwarderTrunk}`
      ]);
      expect(legs.at(0)?.callerId).toBe('+491110202');
    });

    it("the forwarder's own closed hours are the forwarder's call, for an inbound caller with no user", async () => {
      const forwarder = await seedUser(db, { number: '+491110202' });
      // A schedule without open intervals is closed around the clock.
      await db
        .insertInto('openingHours')
        .values({
          id: newId(),
          scopeUserId: forwarder,
          active: 1,
          closedTargetId: await seedTarget(db, { external: FORWARD_NUMBER }),
          createdAt: nowIso()
        })
        .execute();
      const forwarderTrunk = await seedTrunkRoute(db, 1, forwarder);
      await seedTrunkRoute(db, 2, null);

      const legs = await dialled(
        enterTarget(
          pipeline,
          newCallFrom(null, 'inbound'),
          { id: '', kind: 'user', userId: forwarder },
          null
        )
      );

      expect(legs.map(leg => leg.endpoint)).toEqual([
        `PJSIP/${FORWARD_NUMBER}@trunk-${forwarderTrunk}`
      ]);
      expect(legs.at(0)?.callerId).toBe('+491110202');
    });
  });

  describe('a forward nobody made as a user is dialled without a caller', () => {
    /** The caller's own route first, a caller-less one below it: only the latter may carry it. */
    async function seedRoutes(): Promise<string> {
      await seedTrunkRoute(db, 1, caller);
      return seedTrunkRoute(db, 2, null);
    }

    it('a tenant OOO rule presents the main number over a caller-less route', async () => {
      const callee = await seedUser(db, { number: '+491110202' });
      await seedOoo(db, null);
      const openTrunk = await seedRoutes();

      const legs = await dialled(
        enterTarget(
          pipeline,
          call,
          { id: '', kind: 'user', userId: callee },
          null
        )
      );

      expect(legs.map(leg => leg.endpoint)).toEqual([
        `PJSIP/${FORWARD_NUMBER}@trunk-${openTrunk}`
      ]);
      expect(legs.at(0)?.callerId).toBe(MAIN_NUMBER);
    });

    it("a ring group's fallback", async () => {
      const groupId = newId();
      await db
        .insertInto('ringGroups')
        .values({
          id: groupId,
          name: 'Empty',
          strategy: 'simultaneous',
          ringTimeoutS: 30,
          mailboxEnabled: 0,
          createdAt: nowIso()
        })
        .execute();
      await db
        .insertInto('ringGroupForwardRules')
        .values({
          groupId,
          condition: 'unanswered',
          targetId: await seedTarget(db, { external: FORWARD_NUMBER })
        })
        .execute();
      const openTrunk = await seedRoutes();

      const legs = await dialled(ringGroup(pipeline, call, groupId));

      expect(legs.map(leg => leg.endpoint)).toEqual([
        `PJSIP/${FORWARD_NUMBER}@trunk-${openTrunk}`
      ]);
      expect(legs.at(0)?.callerId).toBe(MAIN_NUMBER);
    });

    it("a menu's fallback", async () => {
      const audioId = newId();
      await db
        .insertInto('audioAssets')
        .values({
          id: audioId,
          label: 'Menu',
          kind: 'announcement',
          filename: 'menu.wav',
          createdAt: nowIso()
        })
        .execute();
      const menuId = newId();
      await db
        .insertInto('menus')
        .values({
          id: menuId,
          name: 'Menu',
          audioId,
          fallbackTargetId: await seedTarget(db, { external: FORWARD_NUMBER }),
          timeoutS: 1,
          maxAttempts: 1,
          createdAt: nowIso()
        })
        .execute();
      const openTrunk = await seedRoutes();

      const started = playMenu(pipeline, call, menuId);
      // The menu's 1 s timeout elapses unanswered before its fallback dials.
      const legs = await dialled(started);

      expect(legs.map(leg => leg.endpoint)).toEqual([
        `PJSIP/${FORWARD_NUMBER}@trunk-${openTrunk}`
      ]);
      expect(legs.at(0)?.callerId).toBe(MAIN_NUMBER);
    });

    it('an own DID the caller dialled, whose target is external', async () => {
      const targetId = await seedTarget(db, { external: FORWARD_NUMBER });
      const didId = await seedDid(db, '+491110999', targetId);
      const openTrunk = await seedRoutes();

      const legs = await dialled(
        dispatchAction(
          pipeline,
          call,
          {
            kind: 'ownDid',
            didId,
            number: '+491110999',
            targetId,
            clir: null
          },
          { snapshot: await pipeline.deps.cache.get(), asUser: caller }
        )
      );

      expect(legs.map(leg => leg.endpoint)).toEqual([
        `PJSIP/${FORWARD_NUMBER}@trunk-${openTrunk}`
      ]);
      expect(legs.at(0)?.callerId).toBe(MAIN_NUMBER);
    });
  });

  it('a transfer to an external number presents the transferrer\'s number and CLIR, not the transferee\'s (§10.1 "Transfers and pickup")', async () => {
    const transferrer = await seedUser(db, { number: '+491110202', clir: 1 });
    await seedTrunkRoute(db, 1, caller, 'both');
    const transferrerTrunk = await seedTrunkRoute(db, 2, transferrer, 'both');

    // `call` stands for the transferee's new call: its caller is the transferee, `caller`.
    const legs = await dialled(
      dispatchAction(
        pipeline,
        call,
        { kind: 'external', number: FORWARD_NUMBER, clir: null },
        { snapshot: await pipeline.deps.cache.get(), asUser: transferrer }
      )
    );

    expect(legs.map(leg => leg.endpoint)).toEqual([
      `PJSIP/${FORWARD_NUMBER}@trunk-${transferrerTrunk}`
    ]);
    expect(legs.at(0)?.variables?.['CONNECTEDLINE(pres)']).toBe('prohib');
    expect(legs.at(0)?.callerId).toBe('+491110202');
  });

  it("a plain outbound call is still the caller's own (§10.1 Outbound step 6)", async () => {
    const callerTrunk = await seedTrunkRoute(db, 1, caller);
    await seedTrunkRoute(db, 2, null);

    const legs = await dialled(
      dispatchAction(
        pipeline,
        call,
        { kind: 'external', number: FORWARD_NUMBER, clir: null },
        { snapshot: await pipeline.deps.cache.get(), asUser: caller }
      )
    );

    expect(legs.map(leg => leg.endpoint)).toEqual([
      `PJSIP/${FORWARD_NUMBER}@trunk-${callerTrunk}`
    ]);
    expect(legs.at(0)?.callerId).toBe('+491110101');
  });
});
