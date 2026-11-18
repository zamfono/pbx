/**
 * A call flow's HTTP request (§10.1 step 7 "HTTP requests"): sent while the caller waits, hearing
 * ringing, its JSON answer kept on the call under the request's name for the templates that
 * follow, and the call sent on to the request's target, or to its error target when the request
 * failed. One request and no retry, since the caller waits. The block's rendering and the sender
 * are `@zamfono/shared`'s, which `api` validates and delivers with.
 */
import {
  decodeStoredHeaders,
  errorReason,
  httpReason,
  INVALID_URL_REASON,
  isSuccess,
  MS_PER_SECOND,
  renderRequest,
  type StoredRequest
} from '@zamfono/shared';

import { ignoreGone } from '../ari/failures.js';
import type { Snapshot } from '../internal/snapshot.js';
import { findForwardTarget, type ForwardTarget } from '../routing/targets.js';
import { SIP_TEMPORARILY_UNAVAILABLE } from '../sipCodes.js';
import type { Call } from './call.js';
import type { Forwarder } from './forwardLeg.js';
import { templateValues } from './forwardValues.js';
import type { Pipeline } from './pipeline.js';
import { release } from './release.js';
import { endAtRequestLoop, PLAIN_FORWARD, runTarget } from './runTarget.js';

type HttpRequestTarget = Extract<ForwardTarget, { kind: 'httpRequest' }>;
type Row = Snapshot['httpRequests'][number];

/** The most a response may hold: the limit of an OAuth client's metadata document (§5.2). */
const MAX_RESPONSE_BYTES = 65_536;
/** The reasons of an answer that is no JSON, and of secrets `api` could not hand over. */
const NO_JSON_REASON = 'no JSON';
const SECRET_UNREADABLE_REASON = 'secret unreadable';

/** `url` as the trace shows it: without its query, which can carry a token. */
function tracedUrl(url: string): string {
  const parsed = URL.parse(url);
  return parsed === null ? '' : `${parsed.origin}${parsed.pathname}`;
}

/** `row`'s block with its secrets, which `api` hands over where the row has any. */
async function storedRequest(
  pipeline: Pipeline,
  row: Row
): Promise<StoredRequest> {
  const plain = decodeStoredHeaders(row.headersJson);
  const secrets =
    row.secretEnc === null && row.secretHeadersEnc === null
      ? { secret: null, headers: [] }
      : await pipeline.deps.httpRequests.secrets(row.id);
  return {
    method: row.method,
    url: row.url,
    body: row.body,
    contentType: row.contentType,
    secret: secrets.secret,
    headers: plain.map(header => ({
      name: header.name,
      value:
        'value' in header
          ? header.value
          : (secrets.headers.find(secret => secret.name === header.name)
              ?.value ?? '')
    }))
  };
}

/** What sending `row`'s request for `call` came to: the JSON it answered, or why it failed; with
 * what the trace line shows of it. */
async function send(
  pipeline: Pipeline,
  call: Call,
  row: Row,
  snapshot: Snapshot
): Promise<{
  trace: { method: string; url: string; status?: number };
  answer: { ok: true; json: unknown } | { ok: false; error: string };
}> {
  const failed = (error: string) => ({ ok: false as const, error });
  const trace = { method: row.method, url: tracedUrl(row.url) };
  const stored = await storedRequest(pipeline, row).catch(() => null);
  if (stored === null) {
    return { trace, answer: failed(SECRET_UNREADABLE_REASON) };
  }
  const rendered = renderRequest(
    stored,
    await templateValues(pipeline, call, snapshot)
  );
  if (rendered === null) {
    return { trace, answer: failed(INVALID_URL_REASON) };
  }
  trace.url = tracedUrl(rendered.url);
  try {
    const { status, body } = await pipeline.deps.httpRequests.send({
      ...rendered,
      timeoutMs: row.timeoutS * MS_PER_SECOND,
      policy: pipeline.deps.targetPolicy,
      maxResponseBytes: MAX_RESPONSE_BYTES
    });
    if (!isSuccess(status)) {
      return {
        trace: { ...trace, status },
        answer: failed(httpReason(status))
      };
    }
    try {
      return {
        trace: { ...trace, status },
        answer: { ok: true, json: JSON.parse(body ?? '') as unknown }
      };
    } catch {
      return { trace: { ...trace, status }, answer: failed(NO_JSON_REASON) };
    }
  } catch (error) {
    return { trace, answer: failed(errorReason(error)) };
  }
}

/**
 * Applies the `httpRequest` target `target` to `call`: the request met again since the last
 * clearing event ends the call as a decision met again does (§10.1 step 7 "Loops"), no hop
 * counted; else it is sent, traced at level `events` with its method, its URL without the query,
 * the status or the class of error and how long it took, never a header or a body, and the call
 * goes on to the request's target with the answer under the request's name, or to its error
 * target without one.
 */
export async function runHttpRequest(
  pipeline: Pipeline,
  call: Call,
  target: HttpRequestTarget,
  forwarder: Forwarder | null
): Promise<void> {
  const snapshot = await pipeline.deps.cache.get();
  const row = snapshot.httpRequests.find(
    candidate => candidate.id === target.httpRequestId
  );
  if (row === undefined) {
    // A live target names a live request; one deleted meanwhile leaves the call nowhere to go.
    await release(pipeline, call, SIP_TEMPORARILY_UNAVAILABLE, 'missed');
    return;
  }
  const seen = `httpRequest:${row.id}`;
  if (call.decisionsSeen.has(seen)) {
    await endAtRequestLoop(pipeline, call, row.id);
    return;
  }
  call.decisionsSeen.add(seen);
  if (call.callerChannelId !== null) {
    // The caller hears ringing while the request runs, and is not answered for it.
    await pipeline.deps.ari.channels
      .ring(call.callerChannelId)
      .catch(ignoreGone);
  }
  const startedMs = Date.now();
  const { trace, answer } = await send(pipeline, call, row, snapshot);
  call.log.event({
    event: 'httpRequest',
    httpRequestId: row.id,
    ...trace,
    ...(answer.ok ? {} : { error: answer.error }),
    durationMs: Date.now() - startedMs
  });
  if (call.callerEnded === true) {
    return;
  }
  if (answer.ok) {
    call.variables[row.name] = answer.json;
  }
  await runTarget(
    pipeline,
    call,
    findForwardTarget(snapshot, answer.ok ? row.targetId : row.errorTargetId),
    forwarder,
    PLAIN_FORWARD
  );
}
