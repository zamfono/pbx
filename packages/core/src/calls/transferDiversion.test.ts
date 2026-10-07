import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  ANONYMOUS,
  newId,
  nowIso,
  type Db,
  type DiversionPolicy,
  type ForwardedCallerId
} from '@zamfono/shared';

import type { FakeAri } from '../testing/ari/fake.js';
import { isPlacement, placedCallerId } from '../testing/ari/fakeDial.js';
import { eventually } from '../testing/eventually.js';
import {
  answeredCall,
  legOf,
  startRig,
  type Rig
} from '../testing/pipelineRig.js';
import { seedUserWithDevice } from '../testing/seedRows.js';
import { callerChannel, type Call } from './call.js';
import type { Pipeline } from './pipeline.js';
import { transferCall } from './transfers.js';

// §9.4 "Forwarded calls": a blind transfer's trunk leg carries one hop, the transferring user's
// deflection, so its `Diversion` follows the trunk's policy and its `forwarded_caller_id` applies
// as on a forward; an attended transfer's consultation is the transferrer's own dial and carries
// none.

const TARGET = '+15557777';
const CALLER = '+15559999';
const MAIN = '+15551234';
const PAI = 'PJSIP_HEADER(add,P-Asserted-Identity)';
const PPI = 'PJSIP_HEADER(add,P-Preferred-Identity)';
const DIVERSION = 'PJSIP_HEADER(add,Diversion)';
const DEFLECTION = `"Test User" <sip:${MAIN}@pbx.example.com>;reason=deflection`;

/** A `from` trunk with the catch-all route. */
async function seedTrunk(
  db: Db,
  diversion: DiversionPolicy,
  forwardedCallerId: ForwardedCallerId
): Promise<void> {
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
      diversion,
      forwardedCallerId,
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

describe('a blind transfer to an external number (§9.4 "Forwarded calls")', () => {
  let rig: Rig;
  let db: Db;
  let fakeAri: FakeAri;
  let pipeline: Pipeline;
  let transferrer: string;

  beforeEach(async () => {
    rig = await startRig();
    ({ db, fakeAri, pipeline } = rig);
    fakeAri.answerAfterMs = 60_000;
    transferrer = await seedUserWithDevice(rig, '101');
  });

  afterEach(async () => {
    await rig.stop();
  });

  function trunkLeg(): Promise<Originate> {
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

  /** Blind-transfers the inbound caller `from` of a call `transferrer` answered, over the API. */
  async function transferred(
    from: string,
    adjust: (call: Call) => void = () => undefined
  ): Promise<Originate> {
    const call = await answeredCall(rig, transferrer, { from });
    adjust(call);
    await transferCall(pipeline, call, {
      target: TARGET,
      actorUserId: transferrer
    });
    return trunkLeg();
  }

  it.each(['last', 'all'] as const)(
    'names the transferrer as a deflection in Diversion under %s',
    async diversion => {
      await seedTrunk(db, diversion, 'own');
      const leg = await transferred(CALLER);
      expect(leg.variables?.[DIVERSION]).toBe(DEFLECTION);
      expect(leg.variables?.['REDIRECTING(reason,i)']).toBe('deflection');
      expect(leg.callerId).toBe(MAIN);
      expect(leg.variables?.[PAI]).toBeUndefined();
    }
  );

  it('sends no Diversion under off', async () => {
    await seedTrunk(db, 'off', 'own');
    const leg = await transferred(CALLER);
    expect(leg.variables?.[DIVERSION]).toBeUndefined();
    expect(leg.callerId).toBe(MAIN);
  });

  it.each([
    ['original', PAI, PPI],
    ['originalPreferred', PPI, PAI]
  ] as const)(
    '%s presents the transferee and the own number in its header',
    async (forwardedCallerId, sent, absent) => {
      await seedTrunk(db, 'last', forwardedCallerId);
      const leg = await transferred(CALLER);
      expect(leg.callerId).toBe(CALLER);
      expect(leg.variables?.[sent]).toBe(`<sip:${MAIN}@pbx.example.com>`);
      expect(leg.variables?.[absent]).toBeUndefined();
      expect(leg.variables?.[DIVERSION]).toBe(DEFLECTION);
    }
  );

  it('presents the own number for a withheld transferee', async () => {
    await seedTrunk(db, 'last', 'original');
    const leg = await transferred(ANONYMOUS);
    expect(leg.callerId).toBe(MAIN);
    expect(leg.variables?.[PAI]).toBeUndefined();
    expect(leg.variables?.[DIVERSION]).toBe(DEFLECTION);
  });

  it('presents the own number for an internal transferee', async () => {
    await seedTrunk(db, 'last', 'original');
    const colleague = await seedUserWithDevice(rig, '102');
    const leg = await transferred('102', call => {
      call.direction = 'internal';
      call.callerUserId = colleague;
    });
    expect(leg.callerId).toBe(MAIN);
    expect(leg.variables?.[PAI]).toBeUndefined();
  });

  it.each([
    [
      'all',
      `"Bea" <sip:${MAIN}@pbx.example.com>;reason=unconditional, ${DEFLECTION}`
    ],
    ['last', `"Bea" <sip:${MAIN}@pbx.example.com>;reason=unconditional`]
  ] as const)(
    "keeps the deflection in the chain of a colleague's forward under %s",
    async (diversion, sent) => {
      await seedTrunk(db, diversion, 'original');
      const bea = await seedUserWithDevice(rig, '102');
      await db
        .updateTable('users')
        .set({ name: 'Bea' })
        .where('id', '=', bea)
        .execute();
      const targetId = newId();
      await db
        .insertInto('forwardTargets')
        .values({ id: targetId, external: TARGET })
        .execute();
      await db
        .insertInto('userForwardRules')
        .values({ userId: bea, condition: 'unconditional', targetId })
        .execute();
      const call = await answeredCall(rig, transferrer, { from: CALLER });
      await transferCall(pipeline, call, {
        target: '102',
        actorUserId: transferrer
      });
      const leg = await trunkLeg();
      expect(leg.variables?.[DIVERSION]).toBe(sent);
      expect(leg.variables?.['REDIRECTING(orig-reason,i)']).toBe('deflection');
      expect(leg.variables?.['REDIRECTING(count,i)']).toBe('2');
      expect(leg.callerId).toBe(CALLER);
    }
  );

  it('follows a REFER blind transfer the same way', async () => {
    await seedTrunk(db, 'last', 'original');
    const call = await answeredCall(rig, transferrer);
    const callerId = callerChannel(call);
    fakeAri.emit({
      type: 'BridgeBlindTransfer',
      timestamp: nowIso(),
      application: 'zamfono',
      channel: { id: legOf(call), name: 'PJSIP/e101-a-00000002' },
      transferee: { id: callerId, name: 'PJSIP/trunk-1-00000001' },
      exten: TARGET,
      context: 'from-users',
      result: 'Success',
      is_external: false
    });
    await eventually(async () => {
      const row = await db
        .selectFrom('calls')
        .select('endedAt')
        .where('id', '=', call.id)
        .executeTakeFirstOrThrow();
      expect(row.endedAt).not.toBeNull();
    });
    fakeAri.emit({
      type: 'StasisStart',
      timestamp: nowIso(),
      application: 'zamfono',
      args: ['outbound', TARGET],
      channel: {
        id: callerId,
        name: 'PJSIP/trunk-1-00000001',
        state: 'Up',
        caller: { number: CALLER, name: '' },
        connected: { number: '', name: '' },
        dialplan: { context: 'from-users', exten: TARGET }
      }
    });
    const leg = await trunkLeg();
    expect(leg.callerId).toBe(CALLER);
    expect(leg.variables?.[PAI]).toBe(`<sip:${MAIN}@pbx.example.com>`);
    expect(leg.variables?.[DIVERSION]).toBe(DEFLECTION);
  });
});
