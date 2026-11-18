import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  newId,
  nowIso,
  type Db,
  type DecisionCondition,
  type Presence
} from '@zamfono/shared';
import { seedDid, seedUser } from '@zamfono/shared/testDb.js';

import { ConfigCache } from '../internal/snapshot.js';
import type { FakeAri } from '../testing/ari/fake.js';
import { defaultChannel } from '../testing/ari/fakeChannel.js';
import { eventually } from '../testing/eventually.js';
import { startRig, type Rig } from '../testing/pipelineRig.js';
import {
  seedAudioAsset,
  seedDecision,
  seedExtension,
  seedForwardTarget
} from '../testing/seedRows.js';
import { resolveAddedTarget } from './addPartyTarget.js';
import { newCall, type Call } from './call.js';
import { effectiveStatus } from './callDecisions.js';
import { enterTarget } from './inbound.js';
import type { Pipeline } from './pipeline.js';
import { PLAIN_FORWARD, runTarget } from './runTarget.js';

// The mailbox a call ends in, recorded instead of deposited.
const { deposit } = vi.hoisted(() => ({
  deposit: vi.fn<(...args: unknown[]) => Promise<void>>()
}));
vi.mock('./voicemail.js', async importOriginal => ({
  ...(await importOriginal<typeof import('./voicemail.js')>()),
  deposit
}));

const CALLER = '+436991234567';
const FROM_VIENNA: DecisionCondition = {
  type: 'caller',
  number: '+43',
  isPrefix: true
};

/** `call`'s trace lines of `event`. */
function traced(call: Call, event: string): Record<string, unknown>[] {
  return (call.log.finish().log ?? '')
    .split('\n')
    .filter(line => line !== '')
    .map(line => JSON.parse(line) as Record<string, unknown>)
    .filter(line => line.event === event);
}

describe('a decision on the call path (§10.1 step 7 "Decisions")', () => {
  let rig: Rig;
  let db: Db;
  let fakeAri: FakeAri;
  let pipeline: Pipeline;

  beforeEach(async () => {
    rig = await startRig();
    ({ db, fakeAri, pipeline } = rig);
    deposit.mockReset();
    deposit.mockResolvedValue(undefined);
  });

  afterEach(async () => {
    await rig.stop();
  });

  function makeCall(from = CALLER): Call {
    return newCall({
      id: newId(),
      direction: 'inbound',
      callerChannelId: fakeAri.addChannel({}).id,
      from,
      to: '+4315550100',
      startedAt: nowIso(),
      logLevel: 'events',
      callLogMaxBytes: 1_048_576
    });
  }

  /** A user with a mailbox and no phone: entering them ends in their mailbox (`offline`). */
  function mailboxUser(): Promise<string> {
    return seedUser(db, { mailboxEnabled: 1 });
  }

  it("takes the first matching case, traces it, and enters its target as the DID's own, no hop", async () => {
    const anna = await mailboxUser();
    const ben = await mailboxUser();
    const decisionId = await seedDecision(db, {
      cases: [
        {
          when: [{ type: 'callerUser', userId: null }],
          targetId: await seedForwardTarget(db, { userId: ben })
        },
        {
          when: [FROM_VIENNA],
          targetId: await seedForwardTarget(db, { userId: anna })
        }
      ],
      defaultTargetId: await seedForwardTarget(db, {})
    });
    const call = makeCall();

    await enterTarget(pipeline, call, { kind: 'decision', decisionId }, null, {
      didId: await seedDid(db, '+4315550100')
    });

    expect(traced(call, 'decision')).toMatchObject([
      { event: 'decision', decisionId, decisionCase: 1 }
    ]);
    expect(call.calleeUserId).toBe(anna);
    expect(call.hops).toBe(0);
    expect(deposit).toHaveBeenCalledWith(
      pipeline,
      call,
      { userId: anna },
      'offline'
    );
  });

  it('traces the default when no case matches', async () => {
    const decisionId = await seedDecision(db, {
      cases: [
        {
          when: [{ type: 'callerUser', userId: null }],
          targetId: await seedForwardTarget(db, {})
        }
      ],
      defaultTargetId: await seedForwardTarget(db, {})
    });
    const call = makeCall();

    await enterTarget(pipeline, call, { kind: 'decision', decisionId }, null);

    expect(traced(call, 'decision')).toMatchObject([
      { decisionId, decisionCase: 'default' }
    ]);
    expect(call.status).toBe('missed');
  });

  it('counts a hop on the kind it resolves to: a user, not a mailbox', async () => {
    const anna = await mailboxUser();
    const toUser = await seedDecision(db, {
      cases: [],
      defaultTargetId: await seedForwardTarget(db, { userId: anna })
    });
    const toMailbox = await seedDecision(db, {
      cases: [],
      defaultTargetId: await seedForwardTarget(db, { mailboxUserId: anna })
    });
    const rule = { diversion: null, rule: true };

    const first = makeCall();
    await runTarget(
      pipeline,
      first,
      { kind: 'decision', decisionId: toUser },
      null,
      rule
    );
    expect(first.hops).toBe(1);

    const second = makeCall();
    await runTarget(
      pipeline,
      second,
      { kind: 'decision', decisionId: toMailbox },
      null,
      rule
    );
    expect(second.hops).toBe(0);
    expect(deposit).toHaveBeenLastCalledWith(
      pipeline,
      second,
      { userId: anna },
      'target'
    );
  });

  it("keeps the DID's Diversion for an external target behind a decision, as without it", async () => {
    const toExternal = await seedForwardTarget(db, { external: '+4930123456' });
    const decisionId = await seedDecision(db, {
      cases: [{ when: [FROM_VIENNA], targetId: toExternal }],
      defaultTargetId: await seedForwardTarget(db, {})
    });
    const didId = await seedDid(db, '+4315550100');

    const direct = makeCall();
    await enterTarget(
      pipeline,
      direct,
      { kind: 'external', number: '+4930123456' },
      null,
      { didId }
    );
    const throughDecision = makeCall();
    await enterTarget(
      pipeline,
      throughDecision,
      { kind: 'decision', decisionId },
      null,
      { didId }
    );

    expect(direct.diversions).toHaveLength(1);
    expect(throughDecision.diversions).toEqual(direct.diversions);
    expect(throughDecision.hops).toBe(direct.hops);
  });

  it('plays the decision target’s announcement, then the chosen target’s', async () => {
    const first = await seedAudioAsset(db, { filename: 'first.wav' });
    const second = await seedAudioAsset(db, { filename: 'second.wav' });
    const decisionId = await seedDecision(db, {
      cases: [],
      defaultTargetId: await seedForwardTarget(db, {
        announcementAudioId: second
      })
    });
    const call = makeCall();

    await enterTarget(
      pipeline,
      call,
      { kind: 'decision', decisionId, announcementAudioId: first },
      null
    );

    const played = fakeAri.calls
      .filter(entry => entry.path.endsWith('/play'))
      .map(entry => (entry.body as { media?: string }).media);
    expect(played).toEqual([
      'sound:/media/prompts/first',
      'sound:/media/prompts/second'
    ]);
    expect(call.status).toBe('answered');
  });

  describe('loops (§10.1 step 7 "Loops")', () => {
    /** Decision A whose default leads straight back to A. */
    async function selfLoop(): Promise<string> {
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
      return decisionId;
    }

    it("ends a decision met again as at the hop limit, in the last target's mailbox", async () => {
      const anna = await mailboxUser();
      const decisionId = await selfLoop();
      const call = makeCall();
      call.calleeUserId = anna;

      await enterTarget(pipeline, call, { kind: 'decision', decisionId }, null);

      expect(traced(call, 'decisionLoop')).toMatchObject([{ decisionId }]);
      expect(deposit).toHaveBeenCalledWith(
        pipeline,
        call,
        { userId: anna },
        'hopLimit'
      );
    });

    it('clears the decisions met when a rule forwards, not on a plain forward', async () => {
      const anna = await mailboxUser();
      const decisionId = await seedDecision(db, {
        cases: [],
        defaultTargetId: await seedForwardTarget(db, { mailboxUserId: anna })
      });

      const ruled = makeCall();
      ruled.decisionsSeen.add(decisionId);
      await runTarget(pipeline, ruled, { kind: 'decision', decisionId }, null, {
        diversion: null,
        rule: true
      });
      expect(traced(ruled, 'decisionLoop')).toEqual([]);

      const plain = makeCall();
      plain.decisionsSeen.add(decisionId);
      await runTarget(
        pipeline,
        plain,
        { kind: 'decision', decisionId },
        null,
        PLAIN_FORWARD
      );
      expect(traced(plain, 'decisionLoop')).toMatchObject([{ decisionId }]);
    });

    it('bounds a decision forwarding to an own DID that leads back to it by the hop limit', async () => {
      const back = await seedForwardTarget(db, { external: '+4315550199' });
      const decisionId = await seedDecision(db, {
        cases: [],
        defaultTargetId: back
      });
      await seedDid(
        db,
        '+4315550199',
        await seedForwardTarget(db, { decisionId })
      );
      const call = makeCall();

      await enterTarget(pipeline, call, { kind: 'decision', decisionId }, null);

      // Each entry of the own DID is a hop, which clears the set: no loop, the hop limit ends it.
      expect(traced(call, 'decisionLoop')).toEqual([]);
      expect(traced(call, 'hopLimit')).toHaveLength(1);
      expect(call.hops).toBe(3);
      expect(traced(call, 'decision')).toHaveLength(4);
    });

    it("lets menu keys navigate back through a decision without bound, and ends a menu's fallback back to it", async () => {
      const audioId = await seedAudioAsset(db, { filename: 'menu.wav' });
      const toDecision = await seedForwardTarget(db, {});
      const menuId = newId();
      await db
        .insertInto('menus')
        .values({
          id: menuId,
          name: 'Main',
          audioId,
          fallbackTargetId: toDecision,
          timeoutS: 1,
          maxAttempts: 1,
          createdAt: nowIso()
        })
        .execute();
      const keyToDecision = await seedForwardTarget(db, {});
      await db
        .insertInto('menuTargets')
        .values({ menuId, digits: '1', targetId: keyToDecision })
        .execute();
      const decisionId = await seedDecision(db, {
        cases: [],
        defaultTargetId: await seedForwardTarget(db, { menuId })
      });
      await db
        .updateTable('forwardTargets')
        .set({ decisionId })
        .where('id', 'in', [toDecision, keyToDecision])
        .execute();
      const call = makeCall();
      const channelId = call.callerChannelId ?? '';
      const ari = fakeAri;

      const done = enterTarget(
        pipeline,
        call,
        { kind: 'decision', decisionId },
        null
      );
      for (const greeting of [1, 2, 3]) {
        // eslint-disable-next-line no-await-in-loop -- one key per greeting
        await eventually(() => {
          expect(
            ari.calls.filter(
              entry => entry.path === `channels/${channelId}/play`
            )
          ).toHaveLength(greeting);
        });
        if (greeting < 3) {
          ari.emit({
            type: 'ChannelDtmfReceived',
            timestamp: nowIso(),
            application: 'zamfono',
            channel: defaultChannel({ id: channelId }),
            digit: '1'
          });
        }
      }
      await done;

      // Two keys back to the decision, each clearing; then the fallback meets it again.
      expect(traced(call, 'decision')).toHaveLength(3);
      expect(traced(call, 'decisionLoop')).toMatchObject([{ decisionId }]);
    }, 10_000);
  });

  it("resolves *5's decision extension to the party it picks, refusing a menu or a loop", async () => {
    const ben = await seedUser(db, { ext: '102' });
    await seedDecision(db, {
      cases: [
        {
          when: [{ type: 'callerUser', userId: null }],
          targetId: await seedForwardTarget(db, { userId: ben })
        }
      ],
      defaultTargetId: await seedForwardTarget(db, { mailboxUserId: ben }),
      ext: '650'
    });
    const menuId = newId();
    await db
      .insertInto('menus')
      .values({
        id: menuId,
        name: 'Main',
        audioId: await seedAudioAsset(db),
        fallbackTargetId: await seedForwardTarget(db, {}),
        createdAt: nowIso()
      })
      .execute();
    await seedExtension(db, '660', { menuId });
    const snapshot = await new ConfigCache(db).get();
    const inputs = (userId: string | null) => ({
      now: nowIso(),
      timezone: 'UTC',
      caller: { userId, number: userId === null ? CALLER : '101' },
      statusOf: () => 'available' as const
    });

    // A colleague dials *5650: the decision takes Ben, the extension being what was dialled.
    expect(resolveAddedTarget(snapshot, '650', inputs('anna'))).toEqual({
      kind: 'user',
      userId: ben,
      to: '650',
      hops: 0
    });
    // With no user acting, the running call's caller: the default, a mailbox, is no party.
    expect(resolveAddedTarget(snapshot, '650', inputs(null))).toEqual({
      kind: 'refuse',
      code: 404
    });
    expect(resolveAddedTarget(snapshot, '660', inputs('anna'))).toEqual({
      kind: 'refuse',
      code: 404
    });
    // A decision met again on the way is refused as past the hop limit, the call going on.
    const back = await seedForwardTarget(db, {});
    const looping = await seedDecision(db, {
      cases: [],
      defaultTargetId: back,
      ext: '670'
    });
    await db
      .updateTable('forwardTargets')
      .set({ decisionId: looping })
      .where('id', '=', back)
      .execute();
    expect(
      resolveAddedTarget(await new ConfigCache(db).get(), '670', inputs('anna'))
    ).toEqual({ kind: 'refuse', code: 480 });
  });
});

describe("a presence condition's effective status", () => {
  it('is the user’s own OOO, then their own hours, then the published presence, the tenant’s ignored', async () => {
    const rig = await startRig();
    try {
      const { db } = rig;
      const away = await seedUser(db);
      const closed = await seedUser(db);
      const busy = await seedUser(db);
      const target = await seedForwardTarget(db, {});
      await db
        .insertInto('oooRules')
        .values([
          {
            id: newId(),
            scopeUserId: away,
            active: 1,
            targetId: target,
            createdAt: nowIso()
          },
          // The tenant's OOO is the tenant's, not a user's.
          { id: newId(), active: 1, targetId: target, createdAt: nowIso() }
        ])
        .execute();
      const hoursId = newId();
      await db
        .insertInto('openingHours')
        .values({
          id: hoursId,
          scopeUserId: closed,
          closedTargetId: target,
          createdAt: nowIso()
        })
        .execute();
      const snapshot = await new ConfigCache(db).get();
      const published = new Map<string, Presence>([
        [busy, { status: 'busy', peer: null, ringGroupId: null, since: '' }],
        [closed, { status: 'busy', peer: null, ringGroupId: null, since: '' }]
      ]);
      const statusOf = effectiveStatus(snapshot, published, {
        now: nowIso(),
        timezone: 'UTC'
      });

      expect(statusOf(away)).toBe('away');
      // A schedule with no interval is closed all week.
      expect(statusOf(closed)).toBe('closed');
      expect(statusOf(busy)).toBe('busy');
      expect(statusOf(newId())).toBe('offline');
      expect(
        effectiveStatus(
          snapshot,
          published,
          { now: nowIso(), timezone: 'UTC' },
          { [busy]: 'dnd' }
        )(busy)
      ).toBe('dnd');
    } finally {
      await rig.stop();
    }
  });
});
