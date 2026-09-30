/**
 * Which of a call's channels its `call_qos` rows come from (§7 level `qos`), under which role;
 * `cdrQos.ts` notes them as the call runs.
 */
import type { Call } from './calls/call.js';

export type Role = 'caller' | 'callee';

export type QosTarget = { channelId: string; role: Role };

// The caller's own channel, plus every leg bridged in (`up`) right now; a leg still ringing, or one
// that ended unanswered, never carried the call's own media.
export function qosTargets(call: Call): QosTarget[] {
  // A click-to-dial call has no caller channel ("") until the user's device answers.
  const targets: QosTarget[] =
    call.callerChannelId === ''
      ? []
      : [{ channelId: call.callerChannelId, role: 'caller' }];
  for (const leg of call.legs.values()) {
    if (leg.state === 'up') {
      targets.push({ channelId: leg.channelId, role: 'callee' });
    }
  }
  return targets;
}
