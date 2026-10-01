/**
 * A ring-group batch's legs (§10.1 step 5) as `ringGroupDial.ts`'s race tracks them, and the
 * hangups the race ends them with. Shared by the batch's originate step
 * (`ringGroupOriginate.ts`), its win (`ringGroupWin.ts`) and a pickup of it (`groupPickup.ts`).
 */
import type { Pipeline } from './pipeline.js';

export type GroupLeg = {
  channelId: string;
  userId: string | null;
  memberKey: string;
  state: 'ringing' | 'ended';
  /** The device a member's own leg rings; absent for an external (forwarded) member leg. */
  deviceId?: string;
};

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
