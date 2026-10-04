import { afterEach, describe, expect, it } from 'vitest';

import {
  newId,
  nowIso,
  type Db,
  type MailRequest,
  type UserForwardCondition
} from '@zamfono/shared';

import { type FakeAri } from '../testing/ari/fake.js';
import { isPlacement } from '../testing/ari/fakeDial.js';
import { eventually } from '../testing/eventually.js';
import { answeredCall, startRig, type Rig } from '../testing/pipelineRig.js';
import {
  seedDevice,
  seedExternalRoute,
  seedSlot,
  seedUser
} from '../testing/seedRows.js';
import { CallActions } from './actions.js';
import type { Call, Leg } from './call.js';

// §10.2 "Call parking": a call parked past `settings.parking_timeout_s` rings the parker back;
// unanswered, the parked party goes on in a call of its own to the tenant fallback target, a
// child of the parked call as a blind transfer's onward call is (§10.1 "Transfers and pickup").

// The rings these tests wait out: a one-second park, and a ring-back that rings no device.
const RINGBACK_WAIT_MS = 4000;

type CallsRow = {
  id: string;
  parentCallId: string | null;
  status: string | null;
  answeredAt: string | null;
  answeredByUserId: string | null;
  endedAt: string | null;
  fromUri: string;
  toUri: string;
};

describe('parking ring-back', () => {
  let rig: Rig;
  let db: Db;
  let fakeAri: FakeAri;

  /** `mails` collects the mail requests core posts. */
  async function setUp(mails: MailRequest[] = []): Promise<void> {
    rig = await startRig({
      apiClient: {
        mail: request => {
          mails.push(request);
          return Promise.resolve();
        }
      }
    });
    ({ db, fakeAri } = rig);
    rig.pipeline.deps.trunkState = rig.trunkState();
    await db.updateTable('settings').set({ parkingTimeoutS: 1 }).execute();
    await seedSlot(db, '701');
  }

  afterEach(async () => {
    await rig.stop();
  });

  /** Anna, without a phone or a mailbox, so her ring-back goes unanswered at once. */
  async function seedParker(): Promise<string> {
    const anna = await seedUser(db, { ext: '101' });
    await db
      .updateTable('users')
      .set({ mailboxEnabled: 0 })
      .where('id', '=', anna)
      .execute();
    return anna;
  }

  /** A forward target of `values`. */
  async function seedTarget(values: Record<string, string>): Promise<string> {
    const id = newId();
    await db
      .insertInto('forwardTargets')
      .values({ id, ...values })
      .execute();
    return id;
  }

  /** Makes the forward target of `values` the tenant fallback (§11.3). */
  async function seedFallback(values: Record<string, string>): Promise<void> {
    const fallbackTargetId = await seedTarget(values);
    await db.updateTable('settings').set({ fallbackTargetId }).execute();
  }

  /** Gives `userId` a forward rule for `condition` to the target of `values`. */
  async function seedRule(
    userId: string,
    condition: UserForwardCondition,
    values: Record<string, string>
  ): Promise<void> {
    await db
      .insertInto('userForwardRules')
      .values({ userId, condition, targetId: await seedTarget(values) })
      .execute();
  }

  /** Ben at 102, with a registered phone that answers. */
  async function seedBen(): Promise<string> {
    const ben = await seedUser(db, { ext: '102' });
    await seedDevice(rig, ben, 'e102-a');
    return ben;
  }

  /** Parks the caller of an inbound call `anna` answered. */
  async function parkFor(anna: string): Promise<Call> {
    await rig.devicesUp();
    const call = await answeredCall(rig, anna);
    await new CallActions(rig.pipeline).park(call.id, {
      userId: anna,
      actorUserId: anna
    });
    return call;
  }

  /** The parked party's onward call, once answered, and the parked call's closed row. */
  async function answeredOnward(
    parked: Call
  ): Promise<{ parkedRow: CallsRow; onward: Call }> {
    const party = parked.callerChannelId ?? '';
    const onward = await eventually(() => {
      const live = rig.pipeline.callByChannel.get(party);
      if (live === undefined || live === parked || live.status !== 'answered') {
        throw new Error('the parked party has no answered onward call yet');
      }
      return live;
    }, RINGBACK_WAIT_MS);
    const rows = await db
      .selectFrom('calls')
      .selectAll()
      .where('parentCallId', '=', parked.id)
      .execute();
    expect(rows.map(row => row.id)).toEqual([onward.id]);
    const parkedRow = await db
      .selectFrom('calls')
      .selectAll()
      .where('id', '=', parked.id)
      .executeTakeFirstOrThrow();
    return { parkedRow, onward };
  }

  /** `onward`'s answered leg, once it shares the onward call's bridge with the parked party. */
  function bridgedLeg(parked: Call, onward: Call): Promise<Leg> {
    return eventually(async () => {
      const leg = [...onward.legs.values()].find(
        candidate => candidate.state === 'up'
      );
      if (leg === undefined) {
        throw new Error('the onward call has no answered leg yet');
      }
      const bridges = await rig.ari.bridges.list();
      const members = bridges.find(bridge => bridge.id === onward.bridgeId);
      expect(members?.channels).toEqual(
        expect.arrayContaining([parked.callerChannelId, leg.channelId])
      );
      return leg;
    });
  }

  /** Whether the core placed a channel to an endpoint containing `part`. */
  function placedTo(part: string): boolean {
    return fakeAri.calls.some(
      entry =>
        isPlacement(entry) &&
        ((entry.body as { endpoint?: string }).endpoint ?? '').includes(part)
    );
  }

  it('places no leg once core is stopping, when the park times out after the wind-down', async () => {
    await setUp();
    const anna = await seedParker();
    const ben = await seedBen();
    await seedFallback({ userId: ben });
    await parkFor(anna);
    await rig.pipeline.drain();

    // The onward call to the fallback starts ringing Ben and ends that ring at once.
    await eventually(() => {
      const states = fakeAri.calls
        .filter(entry => entry.path === 'deviceStates/Stasis:presence-102')
        .map(entry => (entry.body as { deviceState: string }).deviceState);
      expect(states.slice(states.indexOf('RINGING'))).toEqual([
        'RINGING',
        'NOT_INUSE'
      ]);
    }, RINGBACK_WAIT_MS);

    expect(placedTo('e101')).toBe(false);
    expect(placedTo('e102')).toBe(false);
  });

  it('connects the parked party to a fallback user who answers, in an onward call of its own', async () => {
    await setUp();
    const anna = await seedParker();
    const ben = await seedBen();
    await seedFallback({ userId: ben });
    const parked = await parkFor(anna);

    const { parkedRow, onward } = await answeredOnward(parked);

    expect(onward.answeredByUserId).toBe(ben);
    expect(onward.from).toBe('+15559999');
    expect(onward.to).toBe('101');
    expect((await bridgedLeg(parked, onward)).userId).toBe(ben);
    // The parked call's row covers the first conversation only: answered by Anna, and ended
    // before the onward call was answered.
    expect(parkedRow.status).toBe('answered');
    expect(parkedRow.answeredByUserId).toBe(anna);
    expect(parkedRow.answeredAt).toBe(parked.answeredAt);
    expect(parkedRow.endedAt).not.toBeNull();
    expect((parkedRow.endedAt ?? '') <= (onward.answeredAt ?? '')).toBe(true);
  });

  it('connects the parked party to a fallback ring group whose member answers', async () => {
    await setUp();
    const anna = await seedParker();
    const ben = await seedBen();
    const groupId = newId();
    await db
      .insertInto('ringGroups')
      .values({
        id: groupId,
        name: 'Support',
        strategy: 'simultaneous',
        createdAt: nowIso()
      })
      .execute();
    await db
      .insertInto('ringGroupMembers')
      .values({ groupId, position: 1, userId: ben, userGroupId: null })
      .execute();
    await seedFallback({ ringGroupId: groupId });
    const parked = await parkFor(anna);

    const { onward } = await answeredOnward(parked);

    expect(onward.answeredByUserId).toBe(ben);
    expect((await bridgedLeg(parked, onward)).userId).toBe(ben);
  });

  it('connects the parked party to a fallback external number that answers', async () => {
    await setUp();
    await seedExternalRoute(db);
    const anna = await seedParker();
    await seedFallback({ external: '+4930123456' });
    const parked = await parkFor(anna);

    const { onward } = await answeredOnward(parked);

    expect((await bridgedLeg(parked, onward)).kind).toBe('trunk');
    expect(placedTo('+4930123456')).toBe(true);
  });

  it('connects the parked party to a fallback SIP target that answers', async () => {
    await setUp();
    const trunkId = await seedExternalRoute(db);
    const anna = await seedParker();
    await seedFallback({
      sipTrunkId: trunkId,
      sipUser: 'agent',
      sipHeadersJson: '[]'
    });
    const parked = await parkFor(anna);

    const { onward } = await answeredOnward(parked);

    expect((await bridgedLeg(parked, onward)).kind).toBe('trunk');
    expect(placedTo('agent')).toBe(true);
  });

  it("sends the parked party where the parker's own forward to a colleague goes, not to the tenant fallback", async () => {
    await setUp();
    const anna = await seedParker();
    const ben = await seedBen();
    const carl = await seedUser(db, { ext: '103' });
    await seedDevice(rig, carl, 'e103-a');
    await seedFallback({ userId: carl });
    // Anna has no phone registered, so her `offline` rule decides the ring-back.
    await seedRule(anna, 'offline', { userId: ben });
    const parked = await parkFor(anna);

    const { onward } = await answeredOnward(parked);

    expect(onward.parentCallId).toBe(parked.id);
    expect((await bridgedLeg(parked, onward)).userId).toBe(ben);
    // A hop of Anna's, as her forward of a direct call to her would be (§9.4 "Forwarded calls").
    expect(onward.diversions.map(hop => [hop.number, hop.reason])).toEqual([
      ['101', 'unavailable']
    ]);
    expect(placedTo('e103-a')).toBe(false);
  });

  it("sends the parked party to the external number the parker's own forward names", async () => {
    await setUp();
    await seedExternalRoute(db);
    const anna = await seedParker();
    await seedRule(anna, 'unconditional', { external: '+4930999888' });
    const parked = await parkFor(anna);

    const { onward } = await answeredOnward(parked);

    expect((await bridgedLeg(parked, onward)).kind).toBe('trunk');
    expect(placedTo('+4930999888')).toBe(true);
  });

  it("leaves the parked party in the parker's mailbox when the parker's rules decide it", async () => {
    await setUp();
    // A deposit waits for Asterisk to end its recording (§10.2 "Voicemail").
    fakeAri.recordingFinishedAfterMs = 5;
    // Anna has her mailbox and no phone registered: `offline`'s implicit default.
    const anna = await seedUser(db, { ext: '101' });
    const ben = await seedBen();
    await seedFallback({ userId: ben });
    const parked = await parkFor(anna);

    await eventually(async () => {
      const onward = await db
        .selectFrom('calls')
        .select(['status', 'toUri'])
        .where('parentCallId', '=', parked.id)
        .execute();
      expect(onward).toEqual([{ status: 'voicemail', toUri: '101' }]);
      const messages = await db
        .selectFrom('voicemails')
        .select('mailboxUserId')
        .execute();
      expect(messages).toEqual([{ mailboxUserId: anna }]);
    }, RINGBACK_WAIT_MS);
    expect(placedTo('e102-a')).toBe(false);
  });

  it('ends the parked call answered, with no missed-call mail, when no tenant fallback takes the party', async () => {
    const mails: MailRequest[] = [];
    await setUp(mails);
    const anna = await seedParker();
    await db
      .updateTable('users')
      .set({ notifyMissedCalls: 1 })
      .where('id', '=', anna)
      .execute();
    const parked = await parkFor(anna);

    const row = await eventually(async () => {
      const closed = await db
        .selectFrom('calls')
        .select(['status', 'endedAt'])
        .where('id', '=', parked.id)
        .executeTakeFirstOrThrow();
      expect(closed.endedAt).not.toBeNull();
      return closed;
    }, RINGBACK_WAIT_MS);

    expect(row.status).toBe('answered');
    expect(mails.filter(mail => mail.kind === 'missedCall')).toEqual([]);
  });

  it('sends the parked party to the tenant fallback when the parker has no forward or mailbox to follow', async () => {
    await setUp();
    const anna = await seedParker();
    // DND without a mailbox releases the ring-back, which leaves the party to the fallback.
    await db
      .updateTable('users')
      .set({ dnd: 1 })
      .where('id', '=', anna)
      .execute();
    const ben = await seedBen();
    await seedFallback({ userId: ben });
    const parked = await parkFor(anna);

    const { onward } = await answeredOnward(parked);

    expect((await bridgedLeg(parked, onward)).userId).toBe(ben);
    expect(onward.diversions).toEqual([]);
  });
});
