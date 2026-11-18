/**
 * One after-call request on its way (§10.6 "After-call requests"): the outbox row holds the
 * call's id and the attempt `core` reported, and each delivery attempt builds the request anew
 * from them, the call's record with a fresh link per recording, so no token is ever stored and a
 * retry never sends an expired one.
 */
import {
  INVALID_URL_REASON,
  isRecord,
  renderRequest,
  targetAttemptSchema,
  type AfterCallReport,
  type Db,
  type TargetAttempt
} from '@zamfono/shared';

import { recordingLinks } from './auth/recordingLinks.js';
import { attempt } from './errors.js';
import {
  AFTER_CALL_PURPOSES,
  CDR_PLACEHOLDER,
  RECORDING_TOKEN_SCOPES
} from './ops/afterCall.js';
import { callRecord } from './ops/calls/get.js';
import { readBlock } from './ops/httpRequestBlock.js';
import type { Keyring } from './secretbox.js';
import { SECRET_UNREADABLE } from './webhookFailure.js';
import type { DeliverySend } from './webhookSend.js';

/** What an after-call delivery's `body_json` holds: no request body, but what one is built from. */
export type AfterCallContext = { callId: string; attempt: TargetAttempt };

export type AfterCallDeps = {
  db: Db;
  kr: Keyring;
  jwtSecret: string;
  /** `https://<FQDN>`, which a recording's links open under. */
  origin: string;
  now: () => string;
};

/** The reason of a delivery whose call is no longer in the history. */
const CALL_GONE = 'call not found';

/** `bodyJson` as the context it was queued with, `null` for anything else. */
function contextOf(bodyJson: string): AfterCallContext | null {
  const parsed = attempt(() => JSON.parse(bodyJson) as unknown);
  if (!isRecord(parsed) || typeof parsed.callId !== 'string') {
    return null;
  }
  const reported = targetAttemptSchema.safeParse(parsed.attempt);
  return reported.success
    ? { callId: parsed.callId, attempt: reported.data }
    : null;
}

/**
 * The call's record as an after-call request sends it (§10.6): the call as `GET /calls/{id}`
 * returns it, without `log`; its recordings, each with the links the request asks for; and the
 * target attempted, with how the attempt ended. `null` for a call no longer in the history.
 */
async function buildRecord(
  deps: AfterCallDeps,
  context: AfterCallContext,
  scope: ('download' | 'delete')[]
): Promise<Record<string, unknown> | null> {
  const call = await callRecord(deps.db, context.callId);
  if (call === null) {
    return null;
  }
  const rows = await deps.db
    .selectFrom('recordings')
    .select(['id', 'userId', 'durationS', 'createdAt'])
    .where('callId', '=', context.callId)
    .orderBy('createdAt')
    .orderBy('id')
    .execute();
  // The attempt but its template values, which are the templates' to read, not the record's.
  const target = Object.fromEntries(
    Object.entries(context.attempt).filter(([field]) => field !== 'values')
  );
  const { forwardTargetId } = context.attempt;
  const nowMs = Date.parse(deps.now());
  const recordings = await Promise.all(
    rows.map(async row => ({
      ...row,
      ...(await recordingLinks(
        deps,
        { id: row.id, forwardTargetId },
        scope,
        nowMs
      ))
    }))
  );
  return { ...call, recordings, target };
}

/**
 * The request delivery `row` sends on this attempt, `{ failure }` for one no attempt could send
 * (a secret that cannot be decrypted, a call gone from the history, a URL template that renders
 * no URL), or `null` when its after-call request is gone, taken off its target or deleted with it,
 * which ends the delivery with no status.
 */
export async function afterCallSend(
  deps: AfterCallDeps,
  row: { afterCallRequestId: string; bodyJson: string }
): Promise<DeliverySend> {
  const request = await deps.db
    .selectFrom('afterCallRequests')
    .selectAll()
    .where('id', '=', row.afterCallRequestId)
    .executeTakeFirst();
  const context = contextOf(row.bodyJson);
  if (request === undefined || context === null) {
    return null;
  }
  const stored = attempt(() =>
    readBlock(deps.kr, AFTER_CALL_PURPOSES, request)
  );
  if (stored === undefined) {
    return { failure: SECRET_UNREADABLE };
  }
  const record = await buildRecord(
    deps,
    context,
    RECORDING_TOKEN_SCOPES.filter(scope =>
      scope === 'download'
        ? request.recordingDownload === 1
        : request.recordingDelete === 1
    )
  );
  if (record === null) {
    return { failure: CALL_GONE };
  }
  const send = renderRequest(
    stored,
    { ...context.attempt.values, [CDR_PLACEHOLDER]: record },
    JSON.stringify(record)
  );
  return send === null ? { failure: INVALID_URL_REASON } : { send };
}

/** The outbox rows of `report`: one per attempt whose forward target has an after-call request,
 * each holding the call's id and the attempt. */
export async function afterCallDeliveries(
  db: Db,
  report: AfterCallReport
): Promise<{ afterCallRequestId: string; bodyJson: string }[]> {
  const requests = await db
    .selectFrom('afterCallRequests')
    .select(['id', 'forwardTargetId'])
    .where(
      'forwardTargetId',
      'in',
      report.attempts.map(reported => reported.forwardTargetId)
    )
    .execute();
  return report.attempts.flatMap(reported => {
    const request = requests.find(
      candidate => candidate.forwardTargetId === reported.forwardTargetId
    );
    const context: AfterCallContext = {
      callId: report.callId,
      attempt: reported
    };
    return request === undefined
      ? []
      : [{ afterCallRequestId: request.id, bodyJson: JSON.stringify(context) }];
  });
}
