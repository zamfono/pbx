/* eslint-disable no-template-curly-in-string -- a literal ${…} is what these tests send and expect back */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  DEFAULT_SIP_HEADERS,
  newId,
  nowIso,
  openDb,
  type Db,
  type SipHeaderTemplate
} from '@zamfono/shared';
import { migrateForTest } from '@zamfono/shared/testDb.js';

import { AmiClient } from '../ami/client.js';
import { AriClient } from '../ari/client.js';
import { FakeAri, isPlacement } from '../ari/fake.js';
import { defaultChannel, type Channel, type Logger } from '../ari/types.js';
import type { ForwardTarget } from '../routing/targets.js';
import { eventually } from '../testing/eventually.js';
import { newCall, type Call } from './call.js';
import { enterTarget } from './inbound.js';
import {
  ConfigCache,
  EventBus,
  Pipeline,
  StateStore,
  type PipelineDeps
} from './pipeline.js';
import { ringGroup } from './ringGroup.js';
import { TrunkState } from './trunkState.js';

// §9.4 "SIP targets" and "Forwarded calls", §10.1 steps 2, 5 and 7: a `sip` target dials its user
// part over its own trunk's hosts, bypassing `outbound_routes`, and every forwarded trunk leg,
// `sip` or `external`, carries the call's forwarding context.

const noopLogger: Logger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined
};

const CALLER = '+15559999';
const CALLED = '+15551077';
const SIP_USER = 'proj_abc123';
// Q.850 38, network out of order, which a 503 from the far end maps to.
const AST_CAUSE_NETWORK_OUT_OF_ORDER = 38;

function fakeCdr(): PipelineDeps['cdr'] {
  return { open: () => Promise.resolve(), finish: () => Promise.resolve() };
}

async function seedTarget(
  db: Db,
  values: Record<string, string>
): Promise<string> {
  const id = newId();
  await db
    .insertInto('forwardTargets')
    .values({ id, ...values })
    .execute();
  return id;
}

async function seedSettings(db: Db): Promise<void> {
  const didId = newId();
  await db
    .insertInto('dids')
    .values({
      id: didId,
      number: '+15551000',
      targetId: await seedTarget(db, { external: '+15550000' }),
      createdAt: nowIso()
    })
    .execute();
  await db
    .insertInto('settings')
    .values({
      id: 1,
      companyName: 'Zamfono',
      mainDidId: didId,
      country: 'DE',
      emergencyNumbersJson: '["112"]'
    })
    .execute();
}

/** A user named `name` on extension `ext`, without devices or a number of their own. */
async function seedUser(db: Db, name: string, ext: string): Promise<string> {
  const id = newId();
  await db
    .insertInto('users')
    .values({
      id,
      name,
      email: `${id}@example.com`,
      createdAt: nowIso(),
      mailboxEnabled: 0
    })
    .execute();
  await db.insertInto('extensions').values({ ext, userId: id }).execute();
  return id;
}

/** An `ip` trunk on TLS with two outbound hosts and an inbound-only one, no route naming it. */
async function seedSipTrunk(db: Db, hosts = 2, priority = 1): Promise<string> {
  const trunkId = newId();
  await db
    .insertInto('trunks')
    .values({
      id: trunkId,
      name: `OpenAI ${priority}`,
      priority,
      emergency: 0,
      authMode: 'ip',
      transport: 'tls',
      createdAt: nowIso()
    })
    .execute();
  const rows = [
    { host: 'sip.api.openai.com', port: 5061, direction: 'outbound' },
    { host: 'sip2.api.openai.com', port: null, direction: 'both' }
  ].slice(0, hosts);
  await db
    .insertInto('trunkHosts')
    .values([
      ...rows.map((row, index) => ({ trunkId, priority: index + 1, ...row })),
      {
        trunkId,
        priority: rows.length + 1,
        host: '13.79.45.80',
        port: null,
        direction: 'inbound'
      }
    ])
    .execute();
  return trunkId;
}

/** A sip target's row, with the default headers unless `headers` are given. */
function sipTargetId(
  db: Db,
  trunkId: string,
  headers: readonly SipHeaderTemplate[] = DEFAULT_SIP_HEADERS
): Promise<string> {
  return seedTarget(db, {
    sipTrunkId: trunkId,
    sipUser: SIP_USER,
    sipHeadersJson: JSON.stringify(headers)
  });
}

/** A DID's own sip target, as the pipeline enters it, with the default headers. */
function sipTarget(trunkId: string): ForwardTarget {
  return {
    id: '',
    kind: 'sip',
    trunkId,
    user: SIP_USER,
    headers: [...DEFAULT_SIP_HEADERS]
  };
}

async function seedRule(
  db: Db,
  userId: string,
  condition: 'unconditional' | 'busy' | 'offline',
  targetId: string
): Promise<void> {
  await db
    .insertInto('userForwardRules')
    .values({ userId, condition, targetId })
    .execute();
}

type Originate = { endpoint: string; variables?: Record<string, string> };

function trunkOriginates(fakeAri: FakeAri): Originate[] {
  return fakeAri.calls
    .filter(entry => isPlacement(entry))
    .map(entry => entry.body as Originate)
    .filter(body => body.endpoint.includes('@trunk-'));
}

/** The forwarding context of a leg: its `REDIRECTING` data and custom headers. */
function forwardContext(leg: Originate | undefined): Record<string, string> {
  return Object.fromEntries(
    Object.entries(leg?.variables ?? {}).filter(
      ([name]) =>
        name.startsWith('REDIRECTING(') || name.startsWith('PJSIP_HEADER(')
    )
  );
}

function traceEvents(call: Call): Record<string, unknown>[] {
  return (call.log.finish().log ?? '')
    .split('\n')
    .filter(line => line !== '')
    .map(line => JSON.parse(line) as Record<string, unknown>);
}

describe('sip forward targets and the forwarding context (§9.4, §10.1 step 7)', () => {
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

  /** An inbound call from `from` to the company number `CALLED`, still ringing. */
  function inboundCall(from = CALLER): Call {
    const call = newCall({
      id: newId(),
      direction: 'inbound',
      callerChannelId: callerChannel.id,
      from,
      to: CALLED,
      startedAt: nowIso(),
      logLevel: 'events',
      callLogMaxBytes: 1_048_576
    });
    pipeline.registerCall(call);
    return call;
  }

  /** Lets `started` run until `count` trunk legs are originated; none answers in these tests. */
  function dialled(started: Promise<void>, count = 1): Promise<Originate[]> {
    started.catch(() => undefined);
    return eventually(() => {
      const legs = trunkOriginates(fakeAri);
      expect(legs).toHaveLength(count);
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
      caller: { number: CALLER, name: '' }
    });
  });

  afterEach(async () => {
    await ari.close();
    await fakeAri.close();
    await db.destroy();
  });

  it('dials the user part at the first outbound host with no route, carrying caller and DID but no diversion', async () => {
    const trunkId = await seedSipTrunk(db);
    const call = inboundCall();

    const legs = await dialled(
      enterTarget(pipeline, call, sipTarget(trunkId), null)
    );

    expect(legs.map(leg => leg.endpoint)).toEqual([
      `PJSIP/${SIP_USER}@trunk-${trunkId}/sip:sip.api.openai.com:5061`
    ]);
    // A DID's own target diverts nobody (§10.1 step 7).
    expect(forwardContext(legs.at(0))).toEqual({
      'PJSIP_HEADER(add,X-Zamfono-Caller)': CALLER,
      'PJSIP_HEADER(add,X-Zamfono-Did)': CALLED
    });
    expect(legs.at(0)?.variables?.['CALLERID(num)']).toBe('+15551000');
  });

  it('fails over to the next outbound host on a 503 (§9.4 "Hosts")', async () => {
    const trunkId = await seedSipTrunk(db);
    const call = inboundCall();
    const started = enterTarget(pipeline, call, sipTarget(trunkId), null);
    await dialled(started);
    const first = await eventually(() => {
      const leg = [...call.legs.values()].find(
        entry => entry.state === 'ringing'
      );
      expect(leg).toBeDefined();
      return leg;
    });
    fakeAri.emit({
      type: 'ChannelDestroyed',
      timestamp: nowIso(),
      application: 'zamfono',
      channel: defaultChannel({ id: first?.channelId ?? '' }),
      cause: AST_CAUSE_NETWORK_OUT_OF_ORDER,
      // eslint-disable-next-line camelcase -- ARI's own field name
      tech_cause: 503
    });

    const legs = await dialled(Promise.resolve(), 2);
    expect(legs.map(leg => leg.endpoint)).toEqual([
      `PJSIP/${SIP_USER}@trunk-${trunkId}/sip:sip.api.openai.com:5061`,
      `PJSIP/${SIP_USER}@trunk-${trunkId}/sip:sip2.api.openai.com`
    ]);
  });

  it('carries both hops of OOO to a user who forwards unconditionally, the last as the Diversion', async () => {
    const trunkId = await seedSipTrunk(db);
    const bea = await seedUser(db, 'Bea', '177');
    const ai = await seedUser(db, 'AI Agent', '178');
    await db
      .insertInto('oooRules')
      .values({
        id: newId(),
        scopeUserId: bea,
        active: 1,
        targetId: await seedTarget(db, { userId: ai }),
        createdAt: nowIso()
      })
      .execute();
    await seedRule(db, ai, 'unconditional', await sipTargetId(db, trunkId));
    const call = inboundCall();

    const legs = await dialled(
      enterTarget(pipeline, call, { id: '', kind: 'user', userId: bea }, null)
    );

    expect(forwardContext(legs.at(0))).toEqual({
      'REDIRECTING(orig-num,i)': '177',
      'REDIRECTING(orig-name,i)': 'Bea',
      'REDIRECTING(orig-reason,i)': 'away',
      'REDIRECTING(from-num,i)': '178',
      'REDIRECTING(from-name,i)': 'AI Agent',
      'REDIRECTING(reason,i)': 'cfu',
      'REDIRECTING(count,i)': '2',
      'PJSIP_HEADER(add,X-Zamfono-Caller)': CALLER,
      'PJSIP_HEADER(add,X-Zamfono-Did)': CALLED
    });
    // AI's own rule: the forward is their call, presenting the main number they fall back to.
    expect(legs.at(0)?.variables?.['CALLERID(num)']).toBe('+15551000');
  });

  it("sends each hop's Diversion by its own number or the main number under the trunk's policy", async () => {
    const trunkId = await seedSipTrunk(db);
    const bea = await seedUser(db, 'Bea', '177');
    const ai = await seedUser(db, 'AI Agent', '178');
    const beaDid = newId();
    await db
      .insertInto('dids')
      .values({
        id: beaDid,
        number: '+15551177',
        targetId: await seedTarget(db, { userId: bea }),
        createdAt: nowIso()
      })
      .execute();
    await db
      .updateTable('users')
      .set({ calleridDidId: beaDid })
      .where('id', '=', bea)
      .execute();
    await db
      .insertInto('oooRules')
      .values({
        id: newId(),
        scopeUserId: bea,
        active: 1,
        targetId: await seedTarget(db, { userId: ai }),
        createdAt: nowIso()
      })
      .execute();
    await seedRule(db, ai, 'unconditional', await sipTargetId(db, trunkId, []));
    const sent = async (policy: 'off' | 'last' | 'all'): Promise<unknown> => {
      await db
        .updateTable('trunks')
        .set({ diversion: policy })
        .where('id', '=', trunkId)
        .execute();
      pipeline.deps.cache.invalidate();
      const before = trunkOriginates(fakeAri).length;
      const started = enterTarget(
        pipeline,
        inboundCall(),
        { id: '', kind: 'user', userId: bea },
        null
      );
      const legs = await dialled(started, before + 1);
      return legs.at(-1)?.variables?.['PJSIP_HEADER(add,Diversion)'];
    };

    // §9.4 "Forwarded calls": AI has no number of their own, so their hop names the main number,
    // Bea's hers, never an extension; newest first, at the trunk's first outbound host.
    expect(await sent('all')).toBe(
      '"AI Agent" <sip:+15551000@sip.api.openai.com>;reason=unconditional, ' +
        '"Bea" <sip:+15551177@sip.api.openai.com>;reason=away'
    );
    expect(await sent('last')).toBe(
      '"AI Agent" <sip:+15551000@sip.api.openai.com>;reason=unconditional'
    );
    expect(await sent('off')).toBeUndefined();
  });

  it("renders a target's templated headers: the called user, the last forwarder and its reason", async () => {
    const trunkId = await seedSipTrunk(db);
    const bea = await seedUser(db, 'Bea', '177');
    const ai = await seedUser(db, 'AI Agent', '178');
    await db
      .insertInto('oooRules')
      .values({
        id: newId(),
        scopeUserId: bea,
        active: 1,
        targetId: await seedTarget(db, { userId: ai }),
        createdAt: nowIso()
      })
      .execute();
    const headers = [
      { name: 'X-Called', value: '{{calledExtension}} {{calledName}}' },
      {
        name: 'X-Forwarded-By',
        value: '{{forwardedByExtension}} {{forwardedByName}} {{forwardReason}}'
      },
      { name: 'X-Hops', value: '{{hopCount}} {{direction}} {{language}}' },
      // No phone book entry and no internal caller: rendered empty, left out.
      { name: 'X-Caller-Name', value: '{{callerName}}' },
      { name: 'X-Literal', value: '${CALLERID(num)} {{did}}' }
    ];
    await seedRule(
      db,
      ai,
      'unconditional',
      await sipTargetId(db, trunkId, headers)
    );
    const call = inboundCall();

    const legs = await dialled(
      enterTarget(pipeline, call, { id: '', kind: 'user', userId: bea }, null)
    );

    const variables = legs.at(0)?.variables ?? {};
    expect(
      Object.fromEntries(
        Object.entries(variables).filter(([name]) =>
          name.startsWith('PJSIP_HEADER(')
        )
      )
    ).toEqual({
      'PJSIP_HEADER(add,X-Called)': '177 Bea',
      'PJSIP_HEADER(add,X-Forwarded-By)': '178 AI Agent unconditional',
      'PJSIP_HEADER(add,X-Hops)': '2 inbound en',
      'PJSIP_HEADER(add,X-Literal)': `\${CALLERID(num)} ${CALLED}`
    });
  });

  it('omits X-Zamfono-Caller for a withheld caller and names a user by their own number', async () => {
    const trunkId = await seedSipTrunk(db);
    const ai = await seedUser(db, 'AI Agent', '178');
    const didId = newId();
    await db
      .insertInto('dids')
      .values({
        id: didId,
        number: '+15551078',
        targetId: await seedTarget(db, { userId: ai }),
        createdAt: nowIso()
      })
      .execute();
    await db
      .updateTable('users')
      .set({ calleridDidId: didId })
      .where('id', '=', ai)
      .execute();
    await seedRule(db, ai, 'unconditional', await sipTargetId(db, trunkId));
    const call = inboundCall('anonymous');

    const legs = await dialled(
      enterTarget(pipeline, call, { id: '', kind: 'user', userId: ai }, null)
    );

    expect(forwardContext(legs.at(0))).toEqual({
      'REDIRECTING(orig-num,i)': '+15551078',
      'REDIRECTING(orig-name,i)': 'AI Agent',
      'REDIRECTING(orig-reason,i)': 'cfu',
      'REDIRECTING(from-num,i)': '+15551078',
      'REDIRECTING(from-name,i)': 'AI Agent',
      'REDIRECTING(reason,i)': 'cfu',
      'REDIRECTING(count,i)': '1',
      'PJSIP_HEADER(add,X-Zamfono-Did)': CALLED
    });
  });

  it('carries the Diversion alone on an external forward, no custom header', async () => {
    const trunkId = newId();
    await db
      .insertInto('trunks')
      .values({
        id: trunkId,
        name: 'Carrier',
        priority: 1,
        emergency: 1,
        authMode: 'ip',
        transport: 'udp',
        createdAt: nowIso()
      })
      .execute();
    await db
      .insertInto('trunkHosts')
      .values({
        trunkId,
        priority: 1,
        host: 'sip.carrier.example',
        port: null,
        direction: 'both'
      })
      .execute();
    await db
      .insertInto('outboundRoutes')
      .values({ id: newId(), priority: 1, trunkId, createdAt: nowIso() })
      .execute();
    const bea = await seedUser(db, 'Bea', '177');
    await seedRule(
      db,
      bea,
      'unconditional',
      await seedTarget(db, { external: '+15557777' })
    );
    const call = inboundCall();

    const legs = await dialled(
      enterTarget(pipeline, call, { id: '', kind: 'user', userId: bea }, null)
    );

    expect(legs.map(leg => leg.endpoint)).toEqual([
      `PJSIP/+15557777@trunk-${trunkId}/sip:sip.carrier.example`
    ]);
    expect(forwardContext(legs.at(0))).toEqual({
      'REDIRECTING(orig-num,i)': '177',
      'REDIRECTING(orig-name,i)': 'Bea',
      'REDIRECTING(orig-reason,i)': 'cfu',
      'REDIRECTING(from-num,i)': '177',
      'REDIRECTING(from-name,i)': 'Bea',
      'REDIRECTING(reason,i)': 'cfu',
      'REDIRECTING(count,i)': '1'
    });
  });

  it("rings a ring-group member's unconditional sip forward as the member's leg, the member its last hop", async () => {
    const trunkId = await seedSipTrunk(db);
    const member = await seedUser(db, 'Bea', '177');
    await db
      .insertInto('devices')
      .values({
        id: newId(),
        userId: member,
        label: 'phone',
        kind: 'manual',
        sipUsername: 'e177-d1',
        sipPasswordEnc: Buffer.from('secret'),
        createdAt: nowIso()
      })
      .execute();
    // With no presence tracker every live device counts as registered (`userDevices.ts`).
    await seedRule(db, member, 'unconditional', await sipTargetId(db, trunkId));
    const groupId = newId();
    await db
      .insertInto('ringGroups')
      .values({
        id: groupId,
        name: 'Support',
        strategy: 'simultaneous',
        ringTimeoutS: 30,
        createdAt: nowIso()
      })
      .execute();
    await db
      .insertInto('extensions')
      .values({ ext: '200', ringGroupId: groupId })
      .execute();
    await db
      .insertInto('ringGroupMembers')
      .values({ groupId, position: 1, userId: member })
      .execute();
    const call = inboundCall();

    const legs = await dialled(ringGroup(pipeline, call, groupId));

    expect(legs.map(leg => leg.endpoint)).toEqual([
      `PJSIP/${SIP_USER}@trunk-${trunkId}/sip:sip.api.openai.com:5061`
    ]);
    expect(forwardContext(legs.at(0))).toMatchObject({
      'REDIRECTING(from-num,i)': '177',
      'REDIRECTING(reason,i)': 'cfu',
      'REDIRECTING(count,i)': '1'
    });
  });

  it('releases with 503 and a sipTarget trace line when the trunk is gone or has no outbound host', async () => {
    const trunkId = await seedSipTrunk(db, 0);
    const deleted = await seedSipTrunk(db, 2, 2);
    await db
      .updateTable('trunks')
      .set({ deletedAt: nowIso() })
      .where('id', '=', deleted)
      .execute();

    for (const [id, cause] of [
      [trunkId, 'noOutboundHost'],
      [deleted, 'trunkMissing']
    ] as const) {
      const call = inboundCall();
      // eslint-disable-next-line no-await-in-loop -- one call per unusable trunk
      await enterTarget(pipeline, call, sipTarget(id), null);
      expect(traceEvents(call)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ event: 'sipTarget', trunkId: id, cause }),
          expect.objectContaining({ event: 'release', code: 503 })
        ])
      );
      expect(call.status).toBe('failed');
    }
    expect(trunkOriginates(fakeAri)).toEqual([]);
  });
  it("maps an offline rule to unavailable, a closed schedule to time_of_day and a group's fallback to its outcome", async () => {
    const trunkId = await seedSipTrunk(db);
    const offline = await seedUser(db, 'Bea', '177');
    await seedRule(db, offline, 'offline', await sipTargetId(db, trunkId));
    const closed = await seedUser(db, 'Carl', '179');
    // A schedule without intervals is never open.
    await db
      .insertInto('openingHours')
      .values({
        id: newId(),
        scopeUserId: closed,
        closedTargetId: await sipTargetId(db, trunkId),
        createdAt: nowIso()
      })
      .execute();
    const groupId = newId();
    await db
      .insertInto('ringGroups')
      .values({
        id: groupId,
        name: 'Nobody',
        strategy: 'simultaneous',
        createdAt: nowIso()
      })
      .execute();
    await db
      .insertInto('extensions')
      .values({ ext: '200', ringGroupId: groupId })
      .execute();
    await db
      .insertInto('ringGroupForwardRules')
      .values({
        groupId,
        condition: 'unanswered',
        targetId: await sipTargetId(db, trunkId)
      })
      .execute();

    const hops: Record<string, string>[] = [];
    for (const started of [
      () =>
        enterTarget(
          pipeline,
          inboundCall(),
          { id: '', kind: 'user', userId: offline },
          null
        ),
      () =>
        enterTarget(
          pipeline,
          inboundCall(),
          { id: '', kind: 'user', userId: closed },
          null
        ),
      () => ringGroup(pipeline, inboundCall(), groupId)
    ]) {
      // eslint-disable-next-line no-await-in-loop -- one call at a time, each adding one leg
      const legs = await dialled(started(), hops.length + 1);
      const context = forwardContext(legs.at(-1));
      hops.push({
        from: context['REDIRECTING(from-num,i)'] ?? '',
        reason: context['REDIRECTING(reason,i)'] ?? ''
      });
    }
    expect(hops).toEqual([
      { from: '177', reason: 'unavailable' },
      { from: '179', reason: 'time_of_day' },
      // No member is ringable, so the `unavailable` outcome falls to the `unanswered` rule.
      { from: '200', reason: 'unavailable' }
    ]);
  });
});
