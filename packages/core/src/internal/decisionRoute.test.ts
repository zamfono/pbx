import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { newId, nowIso, type Db } from '@zamfono/shared';
import {
  migratedTestDb,
  seedSettings,
  seedUser
} from '@zamfono/shared/testDb.js';

import { seedDecision, seedForwardTarget } from '../testing/seedRows.js';
import { dryRun } from './decisionRoute.js';
import { ConfigCache } from './snapshot.js';
import { StateStore } from './stateStore.js';

describe('a decision\'s dry run (§10.3 "Decisions")', () => {
  let db: Db;

  beforeEach(async () => {
    db = await migratedTestDb();
    await seedSettings(db);
  });

  afterEach(async () => {
    await db.destroy();
  });

  function run(decisionId: string, over: Record<string, unknown> = {}) {
    return dryRun(
      { cache: new ConfigCache(db), state: new StateStore(), stackTz: 'UTC' },
      decisionId,
      {
        at: nowIso(),
        caller: { number: '+436991234567' },
        direction: 'inbound',
        presence: {},
        ...over
      }
    );
  }

  it('reports the case taken with each condition and its input, then the OOO rule that overrides it', async () => {
    const anna = await seedUser(db);
    const toAnna = await seedForwardTarget(db, { userId: anna });
    const decisionId = await seedDecision(db, {
      cases: [
        {
          when: [
            { type: 'presence', userId: anna, status: ['available'] },
            { type: 'caller', number: '+43', isPrefix: true }
          ],
          targetId: toAnna
        }
      ],
      defaultTargetId: await seedForwardTarget(db, {})
    });
    const oooRuleId = newId();
    const oooTarget = await seedForwardTarget(db, { mailboxUserId: anna });
    await db
      .insertInto('oooRules')
      .values({
        id: oooRuleId,
        active: 1,
        targetId: oooTarget,
        createdAt: nowIso()
      })
      .execute();

    const result = await run(decisionId, { presence: { [anna]: 'available' } });

    expect(result).toEqual({
      evaluations: [
        {
          decisionId,
          decisionCase: 0,
          targetId: toAnna,
          cases: [
            [
              { type: 'presence', matched: true, value: 'available' },
              {
                type: 'caller',
                matched: true,
                value: { userId: null, number: '+436991234567' }
              }
            ]
          ]
        }
      ],
      loop: null,
      // The tenant's OOO rule applies to Anna as the call's target, overriding the decision.
      ooo: { scope: { kind: 'tenant' }, oooRuleId, targetId: oooTarget },
      hours: null
    });
  });

  it('reports the opening hours for an inbound call alone, and a decision met again as a loop', async () => {
    const group = newId();
    await db
      .insertInto('ringGroups')
      .values({
        id: group,
        name: 'Support',
        strategy: 'simultaneous',
        createdAt: nowIso()
      })
      .execute();
    const closedTarget = await seedForwardTarget(db, {});
    const hoursId = newId();
    // A schedule with no interval is closed all week.
    await db
      .insertInto('openingHours')
      .values({
        id: hoursId,
        scopeRingGroupId: group,
        closedTargetId: closedTarget,
        createdAt: nowIso()
      })
      .execute();
    const decisionId = await seedDecision(db, {
      cases: [],
      defaultTargetId: await seedForwardTarget(db, { ringGroupId: group })
    });

    expect((await run(decisionId))?.hours).toEqual({
      scope: { kind: 'ringGroup', id: group },
      openingHoursId: hoursId,
      open: false,
      closedTargetId: closedTarget
    });
    expect(
      (await run(decisionId, { direction: 'internal' }))?.hours
    ).toBeNull();

    const back = await seedForwardTarget(db, {});
    const looping = await seedDecision(db, {
      cases: [],
      defaultTargetId: back
    });
    await db
      .updateTable('forwardTargets')
      .set({ decisionId: looping })
      .where('id', '=', back)
      .execute();
    expect(await run(looping)).toMatchObject({ loop: looping, ooo: null });
    expect(await run(newId())).toBeNull();
  });
});
