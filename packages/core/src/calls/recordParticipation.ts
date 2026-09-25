/**
 * The recorder as the call pipeline holds it (§10.2 "Call recording"), and the answer-side hook
 * every answer path calls (`answer.ts`). Separate from `recording.ts` so the call path depends
 * on the shape alone.
 */
import type { Call, Leg } from './call.js';

export type ParticipationRecorder = {
  onCallerUp(call: Call): Promise<void>;
  onLegUp(call: Call, leg: Leg): Promise<void>;
  onTransfereeUp(
    call: Call,
    transferee: { channelId: string; userId: string | null }
  ): Promise<void>;
  onCallerEnded(call: Call): Promise<void>;
  onLegEnded(call: Call, leg: Leg): Promise<void>;
};

/**
 * Offers both sides of a newly answered call to the recorder, which applies the effective flag per
 * participation. Called once the winning leg is in the bridge: a snoop attaches to a bridged
 * channel, so this follows the bridge rather than the answer.
 */
export async function recordAnsweredParticipation(
  recorder: ParticipationRecorder | null | undefined,
  call: Call,
  leg: Leg
): Promise<void> {
  await recorder?.onCallerUp(call);
  await recorder?.onLegUp(call, leg);
}
