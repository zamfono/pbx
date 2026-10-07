import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  ANONYMOUS,
  newId,
  nowIso,
  type Db,
  type ForwardedCallerId
} from '@zamfono/shared';
import { seedDid, seedUser } from '@zamfono/shared/testDb.js';

import type { Channel } from '../ari/types.js';
import type { FakeAri } from '../testing/ari/fake.js';
import { isPlacement, placedCallerId } from '../testing/ari/fakeDial.js';
import { eventually } from '../testing/eventually.js';
import { startRig, type Rig } from '../testing/pipelineRig.js';
import { newCall, type Call } from './call.js';
import { enterTarget } from './inbound.js';
import { dispatchAction } from './outboundDispatch.js';
import type { Pipeline } from './pipeline.js';

// §9.4 "Forwarded calls": a trunk's `forwarded_caller_id` has a forwarded leg present the original
// caller in `From`, the tenant's own number, the one the leg presents under `own`, in one
// `P-Asserted-Identity` (`original`) or `P-Preferred-Identity` (`originalPreferred`), and only for
// an inbound caller whose number was transmitted; every other leg presents its own number.

const FORWARDER_NUMBER = '+4930901820';
const CALLER = '+4989123456';
const FORWARD_NUMBER = '+15557777';
const HOTLINE = '+4930901899';
const MAIN = '+15551234';
const PAI = 'PJSIP_HEADER(add,P-Asserted-Identity)';
const PPI = 'PJSIP_HEADER(add,P-Preferred-Identity)';
const DIVERSION = 'PJSIP_HEADER(add,Diversion)';

type TrunkOptions = {
  forwardedCallerId: ForwardedCallerId;
  diversion?: 'off' | 'last' | 'all';
  callerIdFormat?: 'e164' | 'national';
};

/** A `from` trunk with the catch-all route. */
async function seedTrunk(db: Db, options: TrunkOptions): Promise<void> {
  const trunkId = newId();
  await db
    .insertInto('trunks')
    .values({
      id: trunkId,
      name: 'carrier',
      priority: 1,
      emergency: 1,
      authMode: 'registration',
      username: 'acct',
      passwordEnc: Buffer.from('secret'),
      inboundAuth: 0,
      transport: 'udp',
      callerIdHeader: 'from',
      diversion: options.diversion ?? 'last',
      callerIdFormat: options.callerIdFormat ?? 'e164',
      forwardedCallerId: options.forwardedCallerId,
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
}

type Originate = { callerId?: string; variables?: Record<string, string> };

describe('forwarded caller ID (§9.4 "Forwarded calls")', () => {
  let rig: Rig;
  let db: Db;
  let fakeAri: FakeAri;
  let pipeline: Pipeline;
  let callerChannel: Channel;
  let forwarder: string;

  beforeEach(async () => {
    rig = await startRig();
    ({ db, fakeAri, pipeline } = rig);
    fakeAri.answerAfterMs = 60_000;
    callerChannel = fakeAri.addChannel({ caller: { number: '1', name: '' } });
    forwarder = await seedUser(db, {
      name: 'Bea',
      ext: '177',
      mailboxEnabled: 0,
      callerIdDidId: await seedDid(db, FORWARDER_NUMBER)
    });
    const targetId = newId();
    await db
      .insertInto('forwardTargets')
      .values({ id: targetId, external: FORWARD_NUMBER })
      .execute();
    await db
      .insertInto('userForwardRules')
      .values({ userId: forwarder, condition: 'unconditional', targetId })
      .execute();
  });

  afterEach(async () => {
    await rig.stop();
  });

  function callFrom(from: string, direction: Call['direction']): Call {
    const call = newCall({
      id: newId(),
      direction,
      callerChannelId: callerChannel.id,
      from,
      to: '177',
      startedAt: nowIso(),
      logLevel: 'events',
      callLogMaxBytes: 1_048_576
    });
    pipeline.registerCall(call);
    return call;
  }

  /** The trunk leg `started` originates; it never answers here. */
  function trunkLeg(started: Promise<void>): Promise<Originate> {
    started.catch(() => undefined);
    return eventually(() => {
      const leg = fakeAri.calls
        .filter(entry => isPlacement(entry))
        .find(entry =>
          (entry.body as { endpoint: string }).endpoint.includes('@trunk-')
        );
      expect(leg).toBeDefined();
      return {
        ...(leg?.body as Originate),
        callerId: leg === undefined ? undefined : placedCallerId(leg)
      };
    });
  }

  function forwarded(call: Call): Promise<Originate> {
    return trunkLeg(
      enterTarget(pipeline, call, { kind: 'user', userId: forwarder }, null)
    );
  }

  it('own presents the forwarder and adds no identity header', async () => {
    await seedTrunk(db, { forwardedCallerId: 'own' });
    const leg = await forwarded(callFrom(CALLER, 'inbound'));
    expect(leg.callerId).toBe(FORWARDER_NUMBER);
    expect(leg.variables?.[PAI]).toBeUndefined();
    expect(leg.variables?.[PPI]).toBeUndefined();
    expect(leg.variables?.[DIVERSION]).toContain(`sip:${FORWARDER_NUMBER}@`);
  });

  it('original presents the caller in From and asserts the own number', async () => {
    await seedTrunk(db, { forwardedCallerId: 'original' });
    const leg = await forwarded(callFrom(CALLER, 'inbound'));
    expect(leg.callerId).toBe(CALLER);
    expect(leg.variables?.['CALLERID(num)']).toBe(CALLER);
    expect(leg.variables?.[PAI]).toBe(
      `<sip:${FORWARDER_NUMBER}@pbx.example.com>`
    );
    expect(leg.variables?.[PPI]).toBeUndefined();
    expect(leg.variables?.[DIVERSION]).toBe(
      `"Bea" <sip:${FORWARDER_NUMBER}@pbx.example.com>;reason=unconditional`
    );
  });

  it('originalPreferred puts the own number in P-Preferred-Identity instead', async () => {
    await seedTrunk(db, { forwardedCallerId: 'originalPreferred' });
    const leg = await forwarded(callFrom(CALLER, 'inbound'));
    expect(leg.callerId).toBe(CALLER);
    expect(leg.variables?.[PPI]).toBe(
      `<sip:${FORWARDER_NUMBER}@pbx.example.com>`
    );
    expect(leg.variables?.[PAI]).toBeUndefined();
  });

  it("formats both numbers in the trunk's caller-ID format", async () => {
    await seedTrunk(db, {
      forwardedCallerId: 'original',
      callerIdFormat: 'national'
    });
    const leg = await forwarded(callFrom(CALLER, 'inbound'));
    expect(leg.callerId).toBe('089123456');
    expect(leg.variables?.[PAI]).toBe('<sip:030901820@pbx.example.com>');
  });

  it.each(['original', 'originalPreferred'] as const)(
    '%s presents the own number for a withheld caller',
    async forwardedCallerId => {
      await seedTrunk(db, { forwardedCallerId });
      const leg = await forwarded(callFrom(ANONYMOUS, 'inbound'));
      expect(leg.callerId).toBe(FORWARDER_NUMBER);
      expect(leg.variables?.[PAI]).toBeUndefined();
      expect(leg.variables?.[PPI]).toBeUndefined();
    }
  );

  it.each(['original', 'originalPreferred'] as const)(
    '%s presents the own number for an internal caller',
    async forwardedCallerId => {
      await seedTrunk(db, { forwardedCallerId });
      const call = callFrom('101', 'internal');
      call.callerUserId = await seedUser(db, { ext: '101' });
      const leg = await forwarded(call);
      expect(leg.callerId).toBe(FORWARDER_NUMBER);
      expect(leg.variables?.[PAI]).toBeUndefined();
      expect(leg.variables?.[PPI]).toBeUndefined();
    }
  );

  /** A DID `+4930901899` labelled `Hotline` whose own target is the external number. */
  async function seedHotline(): Promise<void> {
    const targetId = newId();
    await db
      .insertInto('forwardTargets')
      .values({ id: targetId, external: FORWARD_NUMBER })
      .execute();
    await db
      .insertInto('dids')
      .values({
        id: newId(),
        number: HOTLINE,
        label: 'Hotline',
        targetId,
        createdAt: nowIso()
      })
      .execute();
  }

  /** The trunk leg of an inbound call from `CALLER` to `called`, as Asterisk hands it over. */
  function callIn(called: string): Promise<Originate> {
    const caller = fakeAri.addChannel({
      name: 'PJSIP/trunk-1-00000001',
      caller: { number: CALLER, name: '' }
    });
    fakeAri.emit({
      type: 'StasisStart',
      timestamp: nowIso(),
      application: 'zamfono',
      args: ['inbound', called],
      channel: caller
    });
    return trunkLeg(Promise.resolve());
  }

  /** A forward target dialling the external number. */
  async function seedExternalTarget(): Promise<string> {
    const targetId = newId();
    await db
      .insertInto('forwardTargets')
      .values({ id: targetId, external: FORWARD_NUMBER })
      .execute();
    return targetId;
  }

  it('a number of a block whose fallback is external names the called number and the block', async () => {
    await seedTrunk(db, { forwardedCallerId: 'original' });
    await db
      .insertInto('didBlocks')
      .values({
        id: newId(),
        base: '+49309018',
        digits: 2,
        label: 'Sales range',
        fallbackTargetId: await seedExternalTarget(),
        createdAt: nowIso()
      })
      .execute();
    const leg = await callIn('+4930901877');
    expect(leg.variables?.[DIVERSION]).toBe(
      '"Sales range" <sip:+4930901877@pbx.example.com>;reason=unconditional'
    );
    expect(leg.callerId).toBe(CALLER);
  });

  it("a number the tenant's fallback sends out names the called number alone", async () => {
    await seedTrunk(db, { forwardedCallerId: 'original' });
    await db
      .updateTable('settings')
      .set({ fallbackTargetId: await seedExternalTarget() })
      .execute();
    const leg = await callIn('+4930999999');
    expect(leg.variables?.[DIVERSION]).toBe(
      '<sip:+4930999999@pbx.example.com>;reason=unconditional'
    );
    expect(leg.callerId).toBe(CALLER);
    expect(leg.variables?.[PAI]).toBe(`<sip:${MAIN}@pbx.example.com>`);
  });

  it('a DID routed straight to an external number names itself in Diversion and presents the caller', async () => {
    await seedTrunk(db, { forwardedCallerId: 'original' });
    await seedHotline();
    const leg = await callIn(HOTLINE);
    expect(leg.variables?.[DIVERSION]).toBe(
      `"Hotline" <sip:${HOTLINE}@pbx.example.com>;reason=unconditional`
    );
    expect(leg.variables?.['REDIRECTING(reason,i)']).toBe('cfu');
    expect(leg.callerId).toBe(CALLER);
    expect(leg.variables?.[PAI]).toBe(`<sip:${MAIN}@pbx.example.com>`);
  });

  it('an own DID dialled internally names itself in Diversion, presenting the own number', async () => {
    await seedTrunk(db, { forwardedCallerId: 'original' });
    await seedHotline();
    const call = callFrom('177', 'internal');
    call.callerUserId = forwarder;
    const snapshot = await pipeline.deps.cache.get();
    const did = snapshot.dids.find(row => row.number === HOTLINE);
    const leg = await trunkLeg(
      dispatchAction(
        pipeline,
        call,
        {
          kind: 'ownDid',
          didId: did?.id ?? '',
          number: HOTLINE,
          targetId: did?.targetId ?? '',
          clir: null
        },
        { snapshot, asUser: forwarder }
      )
    );
    expect(leg.variables?.[DIVERSION]).toBe(
      `"Hotline" <sip:${HOTLINE}@pbx.example.com>;reason=unconditional`
    );
    expect(leg.callerId).toBe(MAIN);
    expect(leg.variables?.[PAI]).toBeUndefined();
  });

  it("leaves a user's own dial as it is", async () => {
    await seedTrunk(db, { forwardedCallerId: 'original' });
    const call = callFrom('177', 'outbound');
    call.callerUserId = forwarder;
    const leg = await trunkLeg(
      dispatchAction(
        pipeline,
        call,
        { kind: 'external', number: FORWARD_NUMBER, clir: null },
        { snapshot: await pipeline.deps.cache.get(), asUser: forwarder }
      )
    );
    expect(leg.callerId).toBe(FORWARDER_NUMBER);
    expect(leg.variables?.[PAI]).toBeUndefined();
    expect(leg.variables?.[DIVERSION]).toBeUndefined();
  });
});
