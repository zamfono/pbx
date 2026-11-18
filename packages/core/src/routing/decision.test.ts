import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  ANONYMOUS,
  type Db,
  type DecisionCondition,
  type DecisionStatus
} from '@zamfono/shared';
import {
  migratedTestDb,
  seedDid,
  seedSettings,
  seedUser
} from '@zamfono/shared/testDb.js';

import { ConfigCache, type Snapshot } from '../internal/snapshot.js';
import {
  seedDecision,
  seedExtension,
  seedForwardTarget
} from '../testing/seedRows.js';
import {
  evaluateCondition,
  resolveDecisions,
  type DecisionInputs
} from './decision.js';
import { resolvePure } from './resolvePure.js';
import type { ForwardTarget } from './targets.js';

// Wednesday 18 November 2026, 18:05 in Vienna (CET, UTC+1).
const WEDNESDAY_EVENING = '2026-11-18T17:05:00Z';

function inputs(over: Partial<DecisionInputs> = {}): DecisionInputs {
  return {
    now: WEDNESDAY_EVENING,
    timezone: 'Europe/Vienna',
    caller: { userId: null, number: '+436991234567' },
    statusOf: () => 'available',
    ...over
  };
}

function matches(condition: DecisionCondition, over = {}): boolean {
  return evaluateCondition(condition, inputs(over)).matched;
}

describe('decision conditions (§10.1 step 7 "Decisions")', () => {
  it('schedule: matches inside a weekly interval in the tenant zone, DST as opening hours', () => {
    const open = { weekday: 3, opens: '08:00', closes: '20:00' };
    expect(matches({ type: 'schedule', intervals: [open] })).toBe(true);
    expect(
      matches({
        type: 'schedule',
        intervals: [{ ...open, closes: '18:00' }]
      })
    ).toBe(false);
    expect(
      evaluateCondition({ type: 'schedule', intervals: [open] }, inputs())
    ).toMatchObject({ value: { weekday: 3, time: '18:05' } });
  });

  it('template: matches when the template renders exactly the text, case-sensitively', () => {
    const values = { did: '+4312345617', crm: { tier: 'VIP' } };
    const at = (template: string, equals: string) =>
      matches({ type: 'template', template, equals }, { values });
    expect(at('{{slice did -2}}', '17')).toBe(true);
    expect(at('{{slice did -2}}', '18')).toBe(false);
    expect(at('{{crm.tier}}', 'VIP')).toBe(true);
    expect(at('{{crm.tier}}', 'vip')).toBe(false);
    // A missing value renders empty, which only an empty text equals.
    expect(at('{{crm.missing.path}}', '')).toBe(true);
    expect(
      evaluateCondition(
        { type: 'template', template: '{{length (digits did)}}', equals: '4' },
        inputs({ values })
      )
    ).toEqual({ type: 'template', matched: false, value: '10' });
    // Without values, as in a context that has none, every placeholder is empty.
    expect(matches({ type: 'template', template: '{{did}}', equals: '' })).toBe(
      true
    );
  });

  it('dates: one-off and yearly ranges, both ends inclusive, wrapping the year end', () => {
    const at = (date: string, ranges: { from: string; to: string }[]) =>
      matches({ type: 'dates', ranges }, { now: `${date}T11:00:00Z` });
    expect(at('2026-11-18', [{ from: '2026-11-18', to: '2026-11-18' }])).toBe(
      true
    );
    expect(at('2026-11-19', [{ from: '2026-11-01', to: '2026-11-18' }])).toBe(
      false
    );
    expect(at('2026-12-30', [{ from: '12-24', to: '01-06' }])).toBe(true);
    expect(at('2027-01-06', [{ from: '12-24', to: '01-06' }])).toBe(true);
    expect(at('2027-01-07', [{ from: '12-24', to: '01-06' }])).toBe(false);
    expect(at('2028-02-29', [{ from: '02-29', to: '02-29' }])).toBe(true);
    expect(at('2027-03-01', [{ from: '02-29', to: '02-29' }])).toBe(false);
  });

  it('dates: the tenant date, not the UTC one', () => {
    // 23:30 UTC on the 17th is the 18th in Vienna.
    expect(
      matches(
        { type: 'dates', ranges: [{ from: '11-18', to: '11-18' }] },
        { now: '2026-11-17T23:30:00Z' }
      )
    ).toBe(true);
  });

  it('caller: an exact number or a prefix, never a tenant user, null for a withheld one', () => {
    const exact = { type: 'caller', number: '+436991234567', isPrefix: false };
    const prefix = { type: 'caller', number: '+43699', isPrefix: true };
    const withheld = { type: 'caller', number: null, isPrefix: false };
    expect(matches(exact as DecisionCondition)).toBe(true);
    expect(matches(prefix as DecisionCondition)).toBe(true);
    expect(matches(withheld as DecisionCondition)).toBe(false);
    const anonymous = { caller: { userId: null, number: ANONYMOUS } };
    expect(matches(withheld as DecisionCondition, anonymous)).toBe(true);
    expect(matches(prefix as DecisionCondition, anonymous)).toBe(false);
    // A colleague on the caller channel is matched by callerUser, never by number.
    const colleague = { caller: { userId: 'u1', number: '+436991234567' } };
    expect(matches(exact as DecisionCondition, colleague)).toBe(false);
  });

  it('callerUser: any tenant user on the caller channel, or that user alone', () => {
    const colleague = { caller: { userId: 'u1', number: '101' } };
    expect(matches({ type: 'callerUser', userId: null }, colleague)).toBe(true);
    expect(matches({ type: 'callerUser', userId: 'u1' }, colleague)).toBe(true);
    expect(matches({ type: 'callerUser', userId: 'u2' }, colleague)).toBe(
      false
    );
    expect(matches({ type: 'callerUser', userId: null })).toBe(false);
  });

  it('presence: the effective status, reported as the value read', () => {
    const statusOf = (userId: string): DecisionStatus =>
      userId === 'u1' ? 'away' : 'busy';
    const presence: DecisionCondition = {
      type: 'presence',
      userId: 'u1',
      status: ['away', 'closed']
    };
    expect(evaluateCondition(presence, inputs({ statusOf }))).toEqual({
      type: 'presence',
      matched: true,
      value: 'away'
    });
    expect(matches({ ...presence, userId: 'u2' }, { statusOf })).toBe(false);
  });

  it('any, all and not combine and nest, each child reported', () => {
    const yes: DecisionCondition = { type: 'callerUser', userId: null };
    const no: DecisionCondition = {
      type: 'caller',
      number: '+1',
      isPrefix: true
    };
    const colleague = { caller: { userId: 'u1', number: '101' } };
    expect(matches({ type: 'any', conditions: [no, yes] }, colleague)).toBe(
      true
    );
    expect(matches({ type: 'all', conditions: [no, yes] }, colleague)).toBe(
      false
    );
    expect(matches({ type: 'not', condition: no }, colleague)).toBe(true);
    expect(
      evaluateCondition(
        { type: 'not', condition: { type: 'any', conditions: [no, yes] } },
        inputs(colleague)
      )
    ).toMatchObject({
      matched: false,
      conditions: [
        {
          type: 'any',
          matched: true,
          conditions: [{ matched: false }, { matched: true }]
        }
      ]
    });
  });
});

describe('resolving through decisions', () => {
  let db: Db;
  let snapshot: Snapshot;

  beforeEach(async () => {
    db = await migratedTestDb();
    await seedSettings(db);
  });

  afterEach(async () => {
    await db.destroy();
  });

  async function load(): Promise<Snapshot> {
    snapshot = await new ConfigCache(db).get();
    return snapshot;
  }

  it('takes the first case whose conditions all match, else the default, tracing each', async () => {
    const userId = await seedUser(db);
    const toUser = await seedForwardTarget(db, { userId });
    const toExternal = await seedForwardTarget(db, { external: '+4930123' });
    const toHangup = await seedForwardTarget(db, {});
    const decisionId = await seedDecision(db, {
      cases: [
        { when: [{ type: 'callerUser', userId: null }], targetId: toUser },
        {
          when: [
            { type: 'caller', number: '+43', isPrefix: true },
            { type: 'callerUser', userId: null }
          ],
          targetId: toHangup
        },
        {
          when: [{ type: 'caller', number: '+43', isPrefix: true }],
          targetId: toExternal
        }
      ],
      defaultTargetId: toHangup
    });
    await load();
    const traced: (number | null)[] = [];
    const resolution = resolveDecisions(
      snapshot,
      { kind: 'decision', decisionId },
      inputs(),
      new Set(),
      evaluation => traced.push(evaluation.caseIndex)
    );
    expect(resolution).toEqual({
      kind: 'resolved',
      target: { kind: 'external', number: '+4930123' },
      announcements: []
    });
    expect(traced).toEqual([2]);
    const fromAbroad = resolveDecisions(
      snapshot,
      { kind: 'decision', decisionId },
      inputs({ caller: { userId: null, number: '+15550100' } }),
      new Set()
    );
    expect(fromAbroad).toMatchObject({ target: { kind: 'hangup' } });
  });

  it('renders the templates of the target it ends at, and follows an extension target (§10.1 step 7 "Templates")', async () => {
    const userId = await seedUser(db);
    await seedExtension(db, '17', { userId });
    const menuId = 'm1';
    const values = { did: '+4312345617', callerNumber: '+43 660 1' };
    await load();
    const resolve = (target: ForwardTarget) =>
      resolveDecisions(snapshot, target, inputs({ values }), new Set());

    expect(
      resolve({ kind: 'external', number: '+43199{{slice did -2}}' })
    ).toMatchObject({
      kind: 'resolved',
      target: { kind: 'external', number: '+4319917' }
    });
    expect(
      resolve({
        kind: 'sip',
        trunkId: 't1',
        user: 'q-{{callerNumber}}',
        headers: []
      })
    ).toMatchObject({ target: { kind: 'sip', user: 'q-+43%20660%201' } });
    expect(
      resolve({
        kind: 'webSocket',
        protocol: 'twilio',
        url: 'wss://bot.example/s?c={{callerNumber}}',
        sampleRate: 8000
      })
    ).toMatchObject({
      target: { url: 'wss://bot.example/s?c=%2B43%20660%201' }
    });
    expect(
      resolve({
        kind: 'extension',
        extension: '{{slice did -2}}',
        announcementAudioId: 'a1'
      })
    ).toEqual({
      kind: 'resolved',
      target: { kind: 'user', userId },
      announcements: ['a1']
    });

    // What a template renders is checked: no number, an extension nobody owns.
    const fallback: ForwardTarget = { kind: 'menu', menuId };
    const noNumber: ForwardTarget = {
      kind: 'external',
      number: '{{callerName}}',
      fallback
    };
    expect(resolve(noNumber)).toEqual({
      kind: 'invalid',
      target: noNumber,
      field: 'external',
      value: ''
    });
    const noOwner: ForwardTarget = {
      kind: 'extension',
      extension: '{{slice did -3}}',
      fallback
    };
    expect(resolve(noOwner)).toEqual({
      kind: 'invalid',
      target: noOwner,
      field: 'extension',
      value: '617'
    });
    expect(resolvePure(snapshot, noOwner, 0, inputs({ values }))).toBeNull();
    expect(
      resolvePure(
        snapshot,
        { kind: 'extension', extension: '{{slice did -2}}' },
        0,
        inputs({ values })
      )
    ).toEqual({ target: { kind: 'user', userId }, hops: 0 });
  });

  it("plays the decision's own announcement, then the chosen target's, through nested decisions", async () => {
    const inner = await seedDecision(db, {
      cases: [],
      defaultTargetId: await seedForwardTarget(db, {
        external: '+4930123',
        announcementAudioId: null
      })
    });
    await db
      .insertInto('audioAssets')
      .values([
        {
          id: 'a1',
          label: 'a1',
          kind: 'announcement',
          filename: 'a1.wav',
          createdAt: 't'
        },
        {
          id: 'a2',
          label: 'a2',
          kind: 'announcement',
          filename: 'a2.wav',
          createdAt: 't'
        }
      ])
      .execute();
    const outer = await seedDecision(db, {
      cases: [],
      defaultTargetId: await seedForwardTarget(db, {
        decisionId: inner,
        announcementAudioId: 'a2'
      })
    });
    await load();
    expect(
      resolveDecisions(
        snapshot,
        { kind: 'decision', decisionId: outer, announcementAudioId: 'a1' },
        inputs(),
        new Set()
      )
    ).toEqual({
      kind: 'resolved',
      target: { kind: 'external', number: '+4930123' },
      announcements: ['a1', 'a2']
    });
  });

  it('reports first decision met again since the last clearing event as first loop', async () => {
    // The first's default leads to the second, the second's back to the first: no hop between them.
    const toSecond = await seedForwardTarget(db, {});
    const first = await seedDecision(db, {
      cases: [],
      defaultTargetId: toSecond
    });
    const toFirst = await seedForwardTarget(db, { decisionId: first });
    const second = await seedDecision(db, {
      cases: [],
      defaultTargetId: toFirst
    });
    await db
      .updateTable('forwardTargets')
      .set({ decisionId: second })
      .where('id', '=', toSecond)
      .execute();
    await load();
    expect(
      resolveDecisions(
        snapshot,
        { kind: 'decision', decisionId: first },
        inputs(),
        new Set()
      )
    ).toEqual({ kind: 'loop', decisionId: first });
    // A decision already in the set is first loop at once.
    expect(
      resolveDecisions(
        snapshot,
        { kind: 'decision', decisionId: second },
        inputs(),
        new Set([second])
      )
    ).toEqual({ kind: 'loop', decisionId: second });
  });

  it('the pure resolver follows own DIDs, each a hop that clears the set, up to the hop limit', async () => {
    const userId = await seedUser(db);
    const toUser = await seedForwardTarget(db, { userId });
    const decisionId = await seedDecision(db, {
      cases: [],
      defaultTargetId: toUser
    });
    await seedDid(db, '+4930100', await seedForwardTarget(db, { decisionId }));
    await load();
    // A forward to the DID's number: one hop, then the decision picks the user.
    expect(
      resolvePure(
        snapshot,
        { kind: 'external', number: '+4930100' },
        0,
        inputs()
      )
    ).toEqual({ target: { kind: 'user', userId }, hops: 1 });
    // The decision met after the hop is not a loop, though it was met before it.
    expect(
      resolvePure(snapshot, { kind: 'decision', decisionId }, 0, inputs())
    ).toEqual({ target: { kind: 'user', userId }, hops: 0 });
    expect(
      resolvePure(
        snapshot,
        { kind: 'external', number: '+4930100' },
        snapshot.settings.maxForwardHops,
        inputs()
      )
    ).toBeNull();
  });

  it('the pure resolver answers null for a hop-free loop', async () => {
    const back = await seedForwardTarget(db, {});
    const decisionId = await seedDecision(db, {
      cases: [],
      defaultTargetId: back
    });
    await db
      .updateTable('forwardTargets')
      .set({ decisionId })
      .where('id', '=', back)
      .execute();
    await load();
    expect(
      resolvePure(snapshot, { kind: 'decision', decisionId }, 0, inputs())
    ).toBeNull();
  });
});
