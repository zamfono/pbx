/**
 * A ring-group batch's own originate step (§10.1 step 5): dials one `MemberLeg` at a time onto
 * the batch's own `tracked` map. Owned and raced by `ringGroupDial.ts`; kept in its own module so
 * both stay under the size limits (§ Global Constraints).
 */
import type { Snapshot } from '../internal/server.js';
import { channelLanguageVariable } from '../prompts.js';
import type { MemberLeg } from '../routing/ringGroup.js';
import type { Call } from './call.js';
import { softphoneCallerId } from './contactName.js';
import { recordEvents, redeliverEarlyEvents } from './earlyEvents.js';
import { ringExternalLeg } from './externalLeg.js';
import { originateLeg } from './legOriginate.js';
import type { Pipeline } from './pipeline.js';
import { devicesToRing } from './userDevices.js';

export type GroupLeg = {
  channelId: string;
  userId: string | null;
  memberKey: string;
  state: 'ringing' | 'ended';
  /** The device a member's own leg rings; absent for an external (forwarded) member leg. */
  deviceId?: string;
};

// --- Task 31 ---
// The hangup helpers `ringGroupDial.ts`'s batch race uses; kept here so both files stay under the
// repository's `max-lines`/`max-lines-per-function` rules.
/** Ends every one of `memberKey`'s still-ringing legs (§10.1 step 5: `allow_reject` stops ringing all of a declining member's devices). */
export function hangupMemberSiblings(
  pipeline: Pipeline,
  tracked: Map<string, GroupLeg>,
  memberKey: string
): void {
  for (const [channelId, leg] of tracked) {
    if (leg.memberKey === memberKey && leg.state === 'ringing') {
      leg.state = 'ended';
      pipeline.deps.ari.channels.hangup(channelId).catch(() => undefined);
    }
  }
}

/** Ends every still-ringing tracked leg; called once a batch concludes, win or not. */
export async function hangupAllRinging(
  pipeline: Pipeline,
  tracked: Map<string, GroupLeg>
): Promise<void> {
  for (const [channelId, leg] of tracked) {
    if (leg.state !== 'ringing') {
      continue;
    }
    leg.state = 'ended';
    // eslint-disable-next-line no-await-in-loop -- losing legs are hung up one at a time; a batch has at most a handful
    await pipeline.deps.ari.channels.hangup(channelId).catch(() => undefined);
  }
}
// --- end Task 31 ---

/** A member leg's owner: whose devices ring (`userId`) and which member it counts against for
 * `allow_reject` purposes (`memberKey`) — the same member, unless a forward rings someone else. */
type LegOwner = { userId: string; memberKey: string };

/** A leg still ringing after the batch has already been won must not keep the winner's phone
 * ringing (§10.1 step 5: "the other legs are hung up"); one racing win can land between this
 * origination's request and its response, so every newly tracked leg is checked again. */
function hangUpIfAlreadyWon(
  pipeline: Pipeline,
  call: Call,
  leg: GroupLeg
): void {
  if (call.answeredAt === null) {
    return;
  }
  leg.state = 'ended';
  pipeline.deps.ari.channels.hangup(leg.channelId).catch(() => undefined);
}

/** Originates every registered device of `owner.userId`, tagging each channel under `owner.memberKey`;
 * for a member already in a call, the devices other than the one carrying it (§10.1 step 5, with
 * `skip_busy` cleared: "rung on their other devices as call waiting"). */
async function originateDevices(
  pipeline: Pipeline,
  call: Call,
  snapshot: Snapshot,
  owner: LegOwner,
  tracked: Map<string, GroupLeg>
): Promise<void> {
  // An unregistered device has nowhere to ring (§10.1 step 5 "offline").
  const devices = await devicesToRing(pipeline, snapshot, owner.userId);
  // §10.2 "Phone book": the contact's display name is the caller-ID name on the member legs.
  const callerId = await softphoneCallerId(pipeline, call);
  for (const device of devices) {
    if (call.answeredAt !== null) {
      break;
    }
    const early = recordEvents(pipeline.deps.ari);
    // eslint-disable-next-line no-await-in-loop -- a member's own devices are originated one at a time; a user has at most a handful
    const channel = await originateLeg(pipeline, call, {
      endpoint: `PJSIP/${device.sipUsername}`,
      app: 'zamfono',
      appArgs: `leg,${call.id}`,
      callerId,
      // §9.1 "every channel's language": a member's leg has been through no entry of its own.
      variables: channelLanguageVariable(snapshot.settings.language)
    })
      .catch(() => null)
      .finally(early.stop);
    if (channel === null) {
      // Refused before it rang (`legOriginate.ts`): the member's device leaves the batch.
      call.log.event({
        event: 'ringGroupMember',
        deviceId: device.id,
        userId: owner.userId,
        cause: 'placementFailed'
      });
      continue;
    }
    const leg: GroupLeg = {
      channelId: channel.id,
      userId: owner.userId,
      memberKey: owner.memberKey,
      state: 'ringing',
      deviceId: device.id
    };
    tracked.set(channel.id, leg);
    call.log.event({
      event: 'ringGroupMember',
      channelId: channel.id,
      userId: owner.userId
    });
    hangUpIfAlreadyWon(pipeline, call, leg);
    // A member's phone that declined at once (486, 603) ended before it was tracked (§10.1 step 5).
    redeliverEarlyEvents(pipeline.deps.ari, early, channel.id);
  }
}

/** A batch's legs as `ringGroupDial.ts`'s race holds them: the tracked channels, and the race's own
 * handling of a leg that ended (§10.1 step 5's decline). */
export type BatchLegs = {
  tracked: Map<string, GroupLeg>;
  end: (leg: GroupLeg, cause: number | null) => void;
};

/** Rings a member's unconditional forward to an external number as the member's leg (§10.1 step 5),
 * dialled as the member's own call (§9.4 "Outbound routing", §10.1 step 7) by `externalLeg.ts`;
 * each attempt's channel is tracked under the member, a superseded one dropped from the batch. */
async function originateExternalLeg(
  pipeline: Pipeline,
  call: Call,
  target: { number: string; memberKey: string },
  batch: BatchLegs
): Promise<void> {
  if (call.answeredAt !== null) {
    return;
  }
  const { tracked } = batch;
  const { memberKey } = target;
  await ringExternalLeg(
    pipeline,
    call,
    { number: target.number, asUser: memberKey },
    {
      track: channelId => {
        const leg: GroupLeg = {
          channelId,
          userId: null,
          memberKey,
          state: 'ringing'
        };
        tracked.set(channelId, leg);
        call.log.event({ event: 'ringGroupMember', channelId, userId: null });
        hangUpIfAlreadyWon(pipeline, call, leg);
      },
      ringing: channelId => tracked.get(channelId)?.state === 'ringing',
      retire: channelId => {
        tracked.delete(channelId);
      },
      end: (channelId, cause) => {
        const leg = tracked.get(channelId);
        if (leg?.state === 'ringing') {
          batch.end(leg, cause);
        }
      }
    }
  );
}

/** One `MemberLeg`'s channel(s): the member's own devices, a forwarded user's devices, or a
 * forwarded external number (§10.1 step 5's "followed as the member's leg"). */
async function originateMemberLeg(
  pipeline: Pipeline,
  call: Call,
  snapshot: Snapshot,
  leg: MemberLeg,
  batch: BatchLegs
): Promise<void> {
  const { tracked } = batch;
  if (leg.via === 'devices') {
    await originateDevices(
      pipeline,
      call,
      snapshot,
      { userId: leg.userId, memberKey: leg.userId },
      tracked
    );
    return;
  }
  if (leg.target.kind === 'user') {
    await originateDevices(
      pipeline,
      call,
      snapshot,
      { userId: leg.target.userId, memberKey: leg.userId },
      tracked
    );
    return;
  }
  if (leg.target.kind === 'external') {
    await originateExternalLeg(
      pipeline,
      call,
      { number: leg.target.number, memberKey: leg.userId },
      batch
    );
  }
}

/** One `ringPlan` batch's members, originated one at a time; stops early once the batch has
 * already been won so a member later in the batch is never rung after the caller is bridged. */
export async function originateBatch(
  pipeline: Pipeline,
  call: Call,
  snapshot: Snapshot,
  legs: MemberLeg[],
  batch: BatchLegs
): Promise<void> {
  for (const leg of legs) {
    if (call.answeredAt !== null) {
      break;
    }
    // eslint-disable-next-line no-await-in-loop -- a batch's members are originated one at a time; a ring group has at most a handful
    await originateMemberLeg(pipeline, call, snapshot, leg, batch);
  }
}
