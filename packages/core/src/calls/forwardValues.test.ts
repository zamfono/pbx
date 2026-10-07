import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { newId, nowIso, type Db } from '@zamfono/shared';
import { migratedTestDb } from '@zamfono/shared/testDb.js';

import type { Snapshot } from '../internal/snapshot.js';
import type { ForwardTarget } from '../routing/targets.js';
import { newCall, type Call } from './call.js';
import type { Diversion } from './forwardContext.js';
import { forwardValues, sipForwardLeg } from './forwardValues.js';
import type { Pipeline } from './pipeline.js';

// §9.4 "Header templates": the values a sip target's placeholders stand for, from the call and
// its forward hops, in "caller → B (out of office) → AI → sip".

const BEA: Diversion = {
  number: '+15551077',
  diversionNumber: '+15551077',
  name: 'Bea',
  reason: 'away',
  party: 'user',
  extension: '177'
};
const AI: Diversion = {
  number: '178',
  diversionNumber: '+15551000',
  name: 'AI Agent',
  reason: 'cfu',
  party: 'user',
  extension: '178'
};
const MENU: Diversion = {
  number: '+15551077',
  diversionNumber: '+15551077',
  name: 'Main menu',
  reason: 'time_of_day',
  party: 'menu',
  extension: null
};

function call(overrides: Partial<Call> = {}): Call {
  return {
    ...newCall({
      id: '0192f3a4-5b6c-7d8e-9f01-23456789abcd',
      direction: 'inbound',
      callerChannelId: 'chan-1',
      from: '+15559999',
      to: '+15551077',
      startedAt: '2026-09-30T12:00:00.000Z',
      logLevel: 'events',
      callLogMaxBytes: 1024
    }),
    ...overrides
  };
}

const snapshot = {
  settings: { language: 'de' },
  users: [{ id: 'u-dana', name: 'Dana Intern' }]
} as unknown as Snapshot;

describe('forwardValues', () => {
  it('names B as the called user and AI as the last forwarder', () => {
    expect(forwardValues(call(), [BEA, AI], snapshot, 'Dana')).toEqual({
      callerNumber: '+15559999',
      callerName: 'Dana',
      did: '+15551077',
      calledExtension: '177',
      calledName: 'Bea',
      forwardedByExtension: '178',
      forwardedByName: 'AI Agent',
      forwardReason: 'unconditional',
      hopCount: '2',
      callId: '0192f3a4-5b6c-7d8e-9f01-23456789abcd',
      direction: 'inbound',
      language: 'de',
      startedAt: '2026-09-30T12:00:00.000Z'
    });
  });

  it('maps every hop reason to its wire name', () => {
    const reasons = (
      [
        'away',
        'time_of_day',
        'cfu',
        'cfb',
        'cfnr',
        'unavailable',
        'dnd'
      ] as const
    ).map(
      reason =>
        forwardValues(call(), [{ ...AI, reason }], snapshot, '').forwardReason
    );
    expect(reasons).toEqual([
      'outOfOffice',
      'closed',
      'unconditional',
      'busy',
      'noAnswer',
      'unavailable',
      'dnd'
    ]);
  });

  it('skips a menu for the called party, but names it as the last forwarder', () => {
    const values = forwardValues(call(), [MENU, BEA, MENU], snapshot, '');
    expect(values).toMatchObject({
      calledExtension: '177',
      calledName: 'Bea',
      forwardedByExtension: '',
      forwardedByName: 'Main menu',
      forwardReason: 'closed',
      hopCount: '3'
    });
  });

  it('names a DID by its label as the forwarder, never as the called party', () => {
    const hotline: Diversion = {
      number: '+15551077',
      diversionNumber: '+15551077',
      name: 'Hotline',
      reason: 'cfu',
      party: 'number',
      extension: null
    };
    expect(forwardValues(call(), [hotline], snapshot, '')).toMatchObject({
      calledExtension: '',
      calledName: '',
      forwardedByExtension: '',
      forwardedByName: 'Hotline',
      forwardReason: 'unconditional',
      hopCount: '1'
    });
  });

  it('leaves the hop placeholders empty without a hop, and a withheld caller and a verbatim DID', () => {
    expect(
      forwardValues(
        call({ from: 'anonymous', to: 'acct-4711' }),
        [],
        snapshot,
        ''
      )
    ).toMatchObject({
      callerNumber: '',
      did: '',
      calledExtension: '',
      calledName: '',
      forwardedByExtension: '',
      forwardedByName: '',
      forwardReason: '',
      hopCount: '0'
    });
  });

  it("gives an internal call its caller's extension and no DID", () => {
    expect(
      forwardValues(
        call({ direction: 'internal', from: '101', to: '178' }),
        [AI],
        snapshot,
        ''
      )
    ).toMatchObject({ callerNumber: '101', did: '', direction: 'internal' });
  });
});

describe('sipForwardLeg', () => {
  let db: Db;

  beforeEach(async () => {
    db = await migratedTestDb();
    const contactId = newId();
    await db
      .insertInto('contacts')
      .values({
        id: contactId,
        displayName: 'Dana from the phone book',
        createdAt: nowIso(),
        updatedAt: nowIso()
      })
      .execute();
    await db
      .insertInto('contactPhones')
      .values({ contactId, label: 'work', number: '+15559999' })
      .execute();
  });

  afterEach(async () => {
    await db.destroy();
  });

  const target: Extract<ForwardTarget, { kind: 'sip' }> = {
    kind: 'sip',
    trunkId: 'trunk-1',
    user: 'proj_1',
    headers: [{ name: 'X-Caller-Name', value: '{{callerName}}' }]
  };

  it("names the caller from the phone book, else an internal caller's user, else leaves it out", async () => {
    const pipeline = { deps: { db } } as unknown as Pipeline;
    const legs = await Promise.all([
      sipForwardLeg(pipeline, call(), target, [AI], snapshot),
      sipForwardLeg(
        pipeline,
        call({ direction: 'internal', from: '101', callerUserId: 'u-dana' }),
        target,
        [AI],
        snapshot
      ),
      sipForwardLeg(pipeline, call({ from: '+15550000' }), target, [], snapshot)
    ]);
    expect(legs.map(leg => leg.headers)).toEqual([
      [{ name: 'X-Caller-Name', value: 'Dana from the phone book' }],
      [{ name: 'X-Caller-Name', value: 'Dana Intern' }],
      []
    ]);
  });
});
