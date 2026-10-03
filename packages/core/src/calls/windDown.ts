/**
 * How `core` ends its calls as it stops (§3.1 "Independence"). A caller not answered yet, and a
 * call arriving during the stop, is released with SIP 503 so a provider can try elsewhere; an
 * answered call is cleared normally. Either way the call is closed out as a REST hangup closes it
 * (`closeCall`): its legs hung up, its recordings and a voicemail deposit in progress saved, its
 * history entry written.
 */
import { ignoreGone } from '../ari/failures.js';
import type { AriEvent, Channel } from '../ari/types.js';
import {
  AST_CAUSE_NORMAL_CLEARING,
  SIP_SERVICE_UNAVAILABLE
} from '../sipCodes.js';
import type { Call } from './call.js';
import { closeCall } from './liveCall.js';
import { abandonOwnRing } from './ownDevices.js';
import type { Pipeline } from './pipeline.js';
import { sipToHangupCause } from './releaseCause.js';

/** The Q.850 cause whose final response is 503 (`releaseCause.ts`). */
const STOPPING_CAUSE = sipToHangupCause(SIP_SERVICE_UNAVAILABLE);

/** A caller's `StasisStart` (§9.2 `inbound,<exten>`, `outbound,<exten>`): the event each call
 * starts with. */
export function startsCall(ev: AriEvent): boolean {
  const [kind] = (ev.args as (string | undefined)[] | undefined) ?? [];
  return (
    ev.type === 'StasisStart' && (kind === 'inbound' || kind === 'outbound')
  );
}

/** Ends `call` with all its channels: released with 503 while unanswered, else cleared. */
export async function windDown(pipeline: Pipeline, call: Call): Promise<void> {
  const answered = call.status === 'answered';
  if (!answered) {
    call.log.event({ event: 'release', code: SIP_SERVICE_UNAVAILABLE });
  }
  // A ring that is all a call with no caller channel has stops outright.
  if (call.callerChannelId === null) {
    abandonOwnRing(pipeline, call);
  }
  await closeCall(
    pipeline,
    call,
    'failed',
    true,
    answered ? AST_CAUSE_NORMAL_CLEARING : STOPPING_CAUSE
  );
}

/** Releases the caller of a call that arrives while `core` stops, before it has a row. */
export async function refuseCall(
  pipeline: Pipeline,
  channel: Channel
): Promise<void> {
  await pipeline.deps.ari.channels
    .hangup(channel.id, { reasonCode: STOPPING_CAUSE })
    .catch(ignoreGone);
}

/** One pipeline's calls being wound down, by id, to the promise that settles as each is closed
 * out. */
export class WindDowns {
  private readonly inProgress = new Map<string, Promise<void>>();

  /** The ids of the calls whose wind-down is in progress. */
  get callIds(): string[] {
    return [...this.inProgress.keys()];
  }

  /** The wind-downs in progress. */
  get pending(): Promise<void>[] {
    return [...this.inProgress.values()];
  }

  /** Starts `call`'s wind-down unless it is in progress already. */
  start(pipeline: Pipeline, call: Call): void {
    if (this.inProgress.has(call.id)) {
      return;
    }
    const done = windDown(pipeline, call)
      .catch((error: unknown) => {
        pipeline.deps.logger.error(
          { err: error, callId: call.id },
          'pipeline: wind-down failed'
        );
      })
      .finally(() => {
        this.inProgress.delete(call.id);
      });
    this.inProgress.set(call.id, done);
  }
}
