/**
 * The live-call routes of the internal API (§3, §10.3 "Live calls"): `POST /internal/calls`,
 * `POST /internal/calls/{id}/{action}` for every action `actionTable.ts`'s `CALL_ROUTES` lists,
 * and the parked calls' read `GET /internal/parking`. `server.ts` mounts `handleActionRoute` and
 * `handleParkingRead`; the actions themselves are `calls/actions.ts`'s `CallActions`.
 */
import type http from 'node:http';

import {
  HTTP_BAD_REQUEST,
  HTTP_OK,
  PROBLEM_CONTENT_TYPE
} from '@zamfono/shared';

import { ActionError } from '../calls/actionError.js';
import type { CallActions } from '../calls/actions.js';
import {
  CALL_ROUTES,
  ORIGINATE_ROUTE,
  type ActionRoute,
  type Body
} from './actionTable.js';
import { readJsonBody, respondJson } from './configChanged.js';

// Action bodies are a few ids and a dial string; this only bounds a request from the internal
// network's one client (§3.1).
const MAX_ACTION_BODY_BYTES = 65536;
const CALL_ACTION_ROUTE =
  /^\/internal\/calls\/(?<callId>[^/]+)\/(?<action>[^/]+)$/u;

/** The JSON object body of an action request, `{}` for an empty one; `null` for a malformed,
 * non-object or oversized one. */
async function readActionBody(
  request: http.IncomingMessage
): Promise<Body | null> {
  const parsed = await readJsonBody(request, MAX_ACTION_BODY_BYTES).catch(
    () => null
  );
  const body = parsed === undefined ? {} : parsed;
  return typeof body === 'object' && body !== null ? (body as Body) : null;
}

/** The route `pathname` names, a call action's run bound to its call; `null` off every action
 * route. */
function matchActionRoute(pathname: string): ActionRoute | null {
  if (pathname === '/internal/calls') {
    return ORIGINATE_ROUTE;
  }
  const groups = CALL_ACTION_ROUTE.exec(pathname)?.groups;
  const callId = groups?.callId;
  const action = groups?.action;
  const route =
    action !== undefined && Object.hasOwn(CALL_ROUTES, action)
      ? CALL_ROUTES[action]
      : undefined;
  if (callId === undefined || route === undefined) {
    return null;
  }
  return {
    ...route,
    run: (actions, body) => route.run(actions, callId, body)
  };
}

/** Whether `body` carries every string field and every flag `route` names in its shape. */
function bodyValid(route: ActionRoute, body: Body): boolean {
  return (
    route.fields.every(field => typeof body[field] === 'string') &&
    (route.flags ?? []).every(
      field => body[field] === undefined || typeof body[field] === 'boolean'
    )
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

/**
 * Serves one action `POST`; `false` when `pathname` names no action route. A refused action (`ActionError`) answers its status as a problem whose `detail` is
 * the cause, where `api`'s core client reads it (§10.2 `noRegisteredDevice`).
 */
export async function handleActionRoute(
  actions: CallActions,
  pathname: string,
  request: http.IncomingMessage,
  response: http.ServerResponse
): Promise<boolean> {
  const route = matchActionRoute(pathname);
  if (route === null) {
    return false;
  }
  const body = await readActionBody(request);
  if (body === null || !bodyValid(route, body)) {
    respondJson(response, HTTP_BAD_REQUEST, { message: 'invalid body' });
    return true;
  }
  try {
    const answer = await route.run(actions, body);
    if (answer.body === undefined) {
      response.writeHead(answer.status);
      response.end();
    } else {
      respondJson(response, answer.status, answer.body);
    }
  } catch (error) {
    if (!(error instanceof ActionError)) {
      throw error;
    }
    respondProblem(response, error.status, error.message, error.reason);
  }
  return true;
}

/** `GET /internal/parking` (§10.2 "Call parking"): the occupied slots; `false` off that path. */
export async function handleParkingRead(
  actions: CallActions,
  pathname: string,
  response: http.ServerResponse
): Promise<boolean> {
  if (pathname !== '/internal/parking') {
    return false;
  }
  respondJson(response, HTTP_OK, await actions.parked());
  return true;
}
