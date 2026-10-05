/**
 * A ring-group batch's own originate step (§10.1 step 5): dials every `MemberLeg` at once onto
 * the batch's own `tracked` map. Owned and raced by `ringGroupDial.ts`.
 */
import { newId } from '@zamfono/shared';

import { logUnlessGone } from '../ari/failures.js';
import type { Snapshot } from '../internal/snapshot.js';
import { channelLanguageVariable } from '../prompts.js';
import type { MemberLeg } from '../routing/ringGroup.js';
import type { Call } from './call.js';
import { softphoneCallerId } from './contactName.js';
import type { GroupLeg } from './groupLegs.js';
import { originateLeg } from './legOriginate.js';
import type { Pipeline } from './pipeline.js';
import { originateExternalLeg } from './ringGroupExternal.js';
import { contactLegs, devicesToRing, type ContactLeg } from './userDevices.js';

/** A member leg's owner: whose devices ring (`userId`) and which member it counts against for
 * `allow_reject` purposes (`memberKey`) — the same member, unless a forward rings someone else. */
type LegOwner = { userId: string; memberKey: string };

/** A leg still ringing after the batch has already been won must not keep the winner's phone
 * ringing (§10.1 step 5: "the other legs are hung up"); one racing win can land between this
 * origination's request and its response, so every newly placed leg is checked again. */
function hangUpIfAlreadyWon(
  pipeline: Pipeline,
  call: Call,
  leg: GroupLeg
): void {
  if (call.answeredAt === null || leg.state !== 'ringing') {
    return;
  }
  leg.state = 'ended';
  pipeline.deps.ari.channels.hangup(leg.channelId).catch(
    logUnlessGone(pipeline.deps.logger, 'ringing leg hangup', {
      callId: call.id
    })
  );
}

/** Originates a contact of one of `owner`'s devices, tracked under `owner.memberKey`: placing,
 * then ringing. */
async function originateDevice(
  pipeline: Pipeline,
  call: Call,
  member: { owner: LegOwner; callerId: string; language: string },
  { device, endpoint }: ContactLeg,
  tracked: Map<string, GroupLeg>
): Promise<void> {
  const { owner } = member;
  const leg: GroupLeg = {
    id: newId(),
    channelId: newId(),
    userId: owner.userId,
    memberKey: owner.memberKey,
    state: 'placing',
    deviceId: device.id
  };
  tracked.set(leg.channelId, leg);
  const placed = await originateLeg(
    pipeline,
    call,
    {
      channelId: leg.channelId,
      endpoint,
      app: 'zamfono',
      appArgs: `leg,${call.id}`,
      callerId: member.callerId,
      // §9.1 "every channel's language": a member's leg has been through no entry of its own.
      variables: channelLanguageVariable(member.language)
    },
    () => {
      leg.state = 'ringing';
      call.log.event({
        event: 'ringGroupMember',
        channelId: leg.channelId,
        userId: owner.userId
      });
    }
  ).then(
    () => true,
    () => false
  );
  if (!placed) {
    // Refused before it rang (`legOriginate.ts`): the member's device leaves the batch.
    tracked.delete(leg.channelId);
    call.log.event({
      event: 'ringGroupMember',
      deviceId: device.id,
      userId: owner.userId,
      cause: 'placementFailed'
    });
    return;
  }
  hangUpIfAlreadyWon(pipeline, call, leg);
}

/** Originates every reachable contact of each registered device of `owner.userId` at once (§9.3
 * "One endpoint per device"), tagging each channel under `owner.memberKey`; for a member already in a call, the devices other
 * than the one carrying it (§10.1 step 5, with `skip_busy` cleared: "rung on their other devices
 * as call waiting"). */
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
  const legs = await contactLegs(pipeline, devices);
  if (call.answeredAt !== null) {
    return;
  }
  const member = { owner, callerId, language: snapshot.settings.language };
  await Promise.all(
    legs.map(leg => originateDevice(pipeline, call, member, leg, tracked))
  );
}

/** A batch's legs as `ringGroupDial.ts`'s race holds them: the tracked channels, and the race's own
 * handling of a leg that ended (§10.1 step 5's decline). */
export type BatchLegs = {
  tracked: Map<string, GroupLeg>;
  end: (leg: GroupLeg, cause: number | null) => void;
};

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
  if (leg.target.kind === 'external' || leg.target.kind === 'sip') {
    await originateExternalLeg(pipeline, call, leg.target, {
      memberKey: leg.userId,
      batch,
      snapshot
    });
  }
}

/** One `ringPlan` batch's members, originated at once (a `simultaneous` batch rings every member
 * together, §10.1 step 5); none once the batch has already been won, so a member is never rung
 * after the caller is bridged. */
export async function originateBatch(
  pipeline: Pipeline,
  call: Call,
  snapshot: Snapshot,
  legs: MemberLeg[],
  batch: BatchLegs
): Promise<void> {
  if (call.answeredAt !== null) {
    return;
  }
  await Promise.all(
    legs.map(leg => originateMemberLeg(pipeline, call, snapshot, leg, batch))
  );
}
