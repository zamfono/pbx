/**
 * `calls.decline` (§10.3 "Live calls"): the actor's own legs ringing for a call end as their
 * phones' 603 Decline ends them, and the call goes on as a decline on the phone makes it go on:
 * a direct ring settles once none of its legs rings or is still to come and applies the user's
 * `noAnswer` rule (§10.1 step 4), and a ring-group batch drops the member and rings on, the
 * group's `allow_reject` deciding as for any decline (§10.1 step 5).
 */
import type { DeclineRequest } from '@zamfono/shared';

import { ignoreGone, logFailure } from '../ari/failures.js';
import { AST_CAUSE_CALL_REJECTED } from '../sipCodes.js';
import { ActionError, HTTP_CONFLICT } from './actionError.js';
import type { Call } from './call.js';
import { activeBatchHasRingingLeg, declineInBatch } from './groupPickup.js';
import type { Pipeline } from './pipeline.js';
import { endRingingLeg } from './ringConclusion.js';

/** `POST /internal/calls/{id}/decline`; 409 `notRinging` when no leg of the actor's rings. */
export function decline(
  pipeline: Pipeline,
  call: Call,
  req: DeclineRequest
): void {
  const userId = req.actorUserId;
  const own = [...call.legs.values()].filter(
    leg => leg.userId === userId && leg.state === 'ringing'
  );
  if (
    own.length === 0 &&
    !activeBatchHasRingingLeg(pipeline, call.id, userId)
  ) {
    throw new ActionError(
      HTTP_CONFLICT,
      'notRinging',
      'nothing of yours is ringing for this call'
    );
  }
  call.log.event({ event: 'decline', actorUserId: userId });
  // Each leg ends before its channel is hung up, so the hangup's own end is never read as a second.
  for (const leg of own) {
    endRingingLeg(pipeline, call, leg, AST_CAUSE_CALL_REJECTED);
    pipeline.deps.ari.channels
      .hangup(leg.channelId)
      .catch(ignoreGone)
      .catch(
        logFailure(pipeline.deps.logger, 'declined leg hangup', {
          callId: call.id
        })
      );
  }
  declineInBatch(pipeline, call, userId, AST_CAUSE_CALL_REJECTED);
}
