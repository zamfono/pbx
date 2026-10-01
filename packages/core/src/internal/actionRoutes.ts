/**
 * The live-call routes of the internal API (§3): `POST /internal/calls`,
 * `/internal/calls/{id}/{transfer|pickup|hangup|park}`, the parked calls' read
 * `GET /internal/parking` and the MWI trigger `/internal/mwi/{mailbox}` (§3.1). `server.ts`
 * mounts `handleActionRoute` and `handleParkingRead`; the actions themselves are
 * `calls/actions.ts`'s `CallActions`.
 */
import type http from 'node:http';

import type {
  Db,
  HangupRequest,
  MwiMailbox,
  OriginateRequest,
  ParkRequest,
  PickupRequest,
  TransferRequest
} from '@zamfono/shared';

import type { AriClient } from '../ari/client.js';
import { refreshMwi } from '../calls/voicemailStore.js';
import { respondJson } from './configChanged.js';
import type { CallActions } from './server.js';

const HTTP_OK = 200;
const HTTP_CREATED = 201;
const HTTP_NO_CONTENT = 204;
const HTTP_BAD_REQUEST = 400;
const HTTP_CONFLICT = 409;
const PROBLEM_CONTENT_TYPE = 'application/problem+json';
// Action bodies are a few ids and a dial string; this only bounds a request from the internal
// network's one client (§3.1).
const MAX_ACTION_BODY_BYTES = 65536;
const CALL_ACTION_ROUTE =
  /^\/internal\/calls\/(?<callId>[^/]+)\/(?<action>transfer|pickup|hangup|park)$/u;
// The mailbox arrives as one path segment, percent-encoded or not (`user:<id>` and `user%3A<id>`
// name the same mailbox), so the segment is decoded before it is matched.
const MWI_ROUTE = /^\/internal\/mwi\/(?<segment>[^/]+)$/u;
// The owner part is an entity id, a UUID (§11.1), and the decoded name is interpolated into the
// ARI REST path `mailboxes/<name>` as it stands, so only that exact shape is accepted.
const MWI_MAILBOX =
  /^(?:user|ringGroup):[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
// The string fields each action's request carries (`internalApi.ts`).
const ACTION_FIELDS = {
  originate: ['userId', 'target', 'actorUserId', 'requestId'],
  transfer: ['target', 'actorUserId'],
  pickup: ['userId', 'actorUserId'],
  hangup: ['actorUserId'],
  park: ['userId', 'actorUserId']
} as const;
type ActionName = keyof typeof ACTION_FIELDS;
type CallActionName = Exclude<ActionName, 'originate'>;
// The optional boolean fields, absent or a boolean: a call's own CLIR, a transfer to the mailbox.
const ACTION_FLAGS: Partial<Record<ActionName, readonly string[]>> = {
  originate: ['clir'],
  transfer: ['voicemail']
};

export type ActionRouteDeps = {
  db: Db;
  ari: AriClient;
  actions: CallActions | null;
};

/** The JSON object body of an action request; `null` for a malformed, non-object or oversized one. */
async function readActionBody(
  request: http.IncomingMessage
): Promise<Record<string, unknown> | null> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request as AsyncIterable<Buffer>) {
    bytes += chunk.length;
    if (bytes > MAX_ACTION_BODY_BYTES) {
      return null;
    }
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  try {
    const parsed: unknown = text === '' ? {} : JSON.parse(text);
    return typeof parsed === 'object' && parsed !== null
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function isCallAction(action: string): action is CallActionName {
  return (
    action === 'transfer' ||
    action === 'pickup' ||
    action === 'hangup' ||
    action === 'park'
  );
}

function matchActionRoute(
  pathname: string
): { callId: string | null; action: ActionName } | null {
  if (pathname === '/internal/calls') {
    return { callId: null, action: 'originate' };
  }
  const groups = CALL_ACTION_ROUTE.exec(pathname)?.groups;
  if (groups === undefined) {
    return null;
  }
  const { callId, action } = groups;
  // Both are mandatory capture groups (not `?`), so a successful match always sets them.
  if (callId === undefined || action === undefined) {
    return null;
  }
  return isCallAction(action) ? { callId, action } : null;
}

/** The mailbox `pathname` names on the MWI route, `null` off it or for a malformed segment. */
function matchMwiRoute(pathname: string): MwiMailbox | null {
  const segment = MWI_ROUTE.exec(pathname)?.groups?.segment;
  if (segment === undefined) {
    return null;
  }
  try {
    const mailbox = decodeURIComponent(segment);
    return MWI_MAILBOX.test(mailbox) ? (mailbox as MwiMailbox) : null;
  } catch {
    return null;
  }
}

/** An `ActionError` from `calls/actionError.ts`, matched by shape so this module imports no call code. */
function isActionFailure(
  error: unknown
): error is Error & { status: number; reason: string } {
  const shape = error as { status?: unknown; reason?: unknown };
  return (
    error instanceof Error &&
    typeof shape.status === 'number' &&
    typeof shape.reason === 'string'
  );
}

/** Runs one call action: what it answers with, `undefined` for an action that answers 204. */
async function runCallAction(
  actions: CallActions,
  callId: string,
  action: CallActionName,
  body: Record<string, unknown>
): Promise<unknown> {
  if (action === 'transfer') {
    await actions.transfer(callId, body as TransferRequest);
    return undefined;
  }
  if (action === 'pickup') {
    await actions.pickup(callId, body as PickupRequest);
    return undefined;
  }
  if (action === 'park') {
    return actions.park(callId, body as ParkRequest);
  }
  await actions.hangup(callId, body as HangupRequest);
  return undefined;
}

/** Whether every field `ACTION_FLAGS` names for `action` is absent or a boolean in `body`. */
function flagsValid(
  action: ActionName,
  body: Record<string, unknown>
): boolean {
  return (ACTION_FLAGS[action] ?? []).every(
    field => body[field] === undefined || typeof body[field] === 'boolean'
  );
}

/** An RFC 9457 problem, the shape `api` answers its own errors in (§10.3): `detail` names the
 * cause (§10.2 `noRegisteredDevice`). */
function respondProblem(
  response: http.ServerResponse,
  status: number,
  title: string,
  detail: string
): void {
  response.writeHead(status, { 'Content-Type': PROBLEM_CONTENT_TYPE });
  response.end(JSON.stringify({ type: 'about:blank', title, status, detail }));
}

async function runOriginate(
  actions: CallActions,
  body: Record<string, unknown>,
  response: http.ServerResponse
): Promise<void> {
  const result = await actions.originate(body as OriginateRequest);
  if ('error' in result) {
    respondProblem(
      response,
      HTTP_CONFLICT,
      'no registered device',
      result.error
    );
    return;
  }
  respondJson(response, HTTP_CREATED, result);
}

/**
 * Serves one action `POST`; `false` when `pathname` names no action route, or the actions are
 * not mounted. A refused action answers its status as a problem whose `detail` is the cause, where
 * `api`'s core client reads it (§10.2 `noRegisteredDevice`).
 */
export async function handleActionRoute(
  deps: ActionRouteDeps,
  pathname: string,
  request: http.IncomingMessage,
  response: http.ServerResponse
): Promise<boolean> {
  const mailbox = matchMwiRoute(pathname);
  if (mailbox !== null) {
    await refreshMwi({ ari: deps.ari, db: deps.db }, mailbox);
    response.writeHead(HTTP_NO_CONTENT);
    response.end();
    return true;
  }
  const route = matchActionRoute(pathname);
  if (route === null || deps.actions === null) {
    return false;
  }
  const body = await readActionBody(request);
  const fields: readonly string[] = ACTION_FIELDS[route.action];
  if (
    body === null ||
    !fields.every(field => typeof body[field] === 'string') ||
    !flagsValid(route.action, body)
  ) {
    respondJson(response, HTTP_BAD_REQUEST, { message: 'invalid body' });
    return true;
  }
  try {
    if (route.callId === null || route.action === 'originate') {
      await runOriginate(deps.actions, body, response);
      return true;
    }
    const result = await runCallAction(
      deps.actions,
      route.callId,
      route.action,
      body
    );
    if (result === undefined) {
      response.writeHead(HTTP_NO_CONTENT);
      response.end();
    } else {
      respondJson(response, HTTP_OK, result);
    }
  } catch (error) {
    if (!isActionFailure(error)) {
      throw error;
    }
    respondProblem(response, error.status, error.message, error.reason);
  }
  return true;
}

/** `GET /internal/parking` (§10.2 "Call parking"): the occupied slots; `false` off that path or
 * while the actions are not mounted. */
export async function handleParkingRead(
  actions: CallActions | null,
  pathname: string,
  response: http.ServerResponse
): Promise<boolean> {
  if (pathname !== '/internal/parking' || actions === null) {
    return false;
  }
  respondJson(response, HTTP_OK, await actions.parked());
  return true;
}
