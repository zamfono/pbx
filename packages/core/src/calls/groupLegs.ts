/**
 * A ring-group batch's legs (§10.1 step 5) as `ringGroupDial.ts`'s race tracks them, and the
 * hangups the race ends them with. Shared by the batch's originate step
 * (`ringGroupOriginate.ts`), its win (`ringGroupWin.ts`) and a pickup of it (`groupPickup.ts`).
 */
import { logUnlessGone } from '../ari/failures.js';
import type { Pipeline } from './pipeline.js';

export type GroupLeg = {
  /** As a `Leg`'s `id`: its own once it wins (`ringGroupWin.ts`). */
  id: string;
  channelId: string;
  userId: string | null;
  memberKey: string;
  /** As a `Leg`'s: `placing` until its dial is sent, its placement's to settle until then. */
  state: 'placing' | 'ringing' | 'ended';
  /** The device a member's own leg rings; absent for an external (forwarded) member leg. */
  deviceId?: string;
  /** An external (forwarded) member leg, whose channel's end its attempt handles
   * (`externalAttempt.ts`). */
  external?: true;
  /** As a `Leg`'s: the member whose unconditional forward an external member leg dials. */
  standsInFor?: string;
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
      pipeline.deps.ari.channels
        .hangup(channelId)
        .catch(logUnlessGone(pipeline.deps.logger, 'member leg hangup'));
    }
  }
}

/** Ends every still-ringing tracked leg; called once a batch concludes, win or not. */
export async function hangupAllRinging(
  pipeline: Pipeline,
  tracked: Map<string, GroupLeg>
): Promise<void> {
  const ringing = [...tracked].filter(([, leg]) => leg.state === 'ringing');
  await Promise.all(
    ringing.map(([channelId, leg]) => {
      leg.state = 'ended';
      return pipeline.deps.ari.channels
        .hangup(channelId)
        .catch(logUnlessGone(pipeline.deps.logger, 'losing leg hangup'));
    })
  );
}
