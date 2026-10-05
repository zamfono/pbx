/**
 * The missed-call notification (§10.2 "Mail"): a user whose `notify_missed_calls` is set is told
 * about a call that rang them and was never answered. `api` renders and sends it; `core` only
 * posts the request (§3.1 "Mail").
 */
import type { MailRequest } from '@zamfono/shared';

import { logFailure } from '../ari/failures.js';
import { userById } from '../internal/snapshot.js';
import type { Call, CallsRow } from './call.js';
import { callerNumber, contactName } from './contactName.js';
import type { Pipeline } from './pipeline.js';

/**
 * Posts the notification for `call` when it went unanswered and the user it rang wants to hear
 * about it. The mail is "one per missed inbound call" (§10.2 "Mail"), so a colleague's internal
 * call notifies no one, and neither does a call that reached nobody in particular — no callee,
 * an announcement, a menu the caller abandoned.
 */
export async function notifyMissedCall(
  pipeline: Pipeline,
  call: Call
): Promise<void> {
  const { db, apiClient } = pipeline.deps;
  const userId = call.calleeUserId;
  if (userId === null || call.direction !== 'inbound') {
    return;
  }
  const snapshot = await pipeline.deps.cache.get();
  const user = userById(snapshot, userId);
  if (user?.notifyMissedCalls !== 1) {
    return;
  }
  const did =
    call.didId === null
      ? undefined
      : snapshot.dids.find(row => row.id === call.didId);
  const request: MailRequest = {
    kind: 'missedCall',
    callId: call.id,
    to: { userId },
    values: {
      callerNumber: callerNumber(call.from),
      callerName: await contactName(db, call.from),
      receivedAt: call.startedAt,
      didLabel: did?.label ?? did?.number ?? ''
    }
  };
  await apiClient
    .mail(request)
    .catch(
      logFailure(pipeline.deps.logger, 'missed-call mail', { callId: call.id })
    );
}

/** Records how `call` ended (§11.2 `calls.status`), keeping an outcome it already reached: a
 * call this leaves `missed` gets its missed-call mail, once. */
export async function settleStatus(
  pipeline: Pipeline,
  call: Call,
  status: CallsRow['status']
): Promise<void> {
  if (call.status !== null) {
    return;
  }
  call.status = status;
  if (status === 'missed') {
    await notifyMissedCall(pipeline, call);
  }
}

/** Closes out a call whose caller left before any outcome was reached as `missed`
 * (`settleStatus`); the row of a call already closed is kept (`cdr.finish` writes once). */
export async function finishAbandoned(
  pipeline: Pipeline,
  call: Call
): Promise<void> {
  await settleStatus(pipeline, call, 'missed');
  await pipeline.finishCall(call);
}
