/**
 * The live-call routes of the internal API (§3, §10.3 "Live calls"): `POST /internal/calls`,
 * `POST /internal/calls/{id}/{action}` for every action `actionTable.ts`'s `CALL_ROUTES` lists,
 * and the parked calls' read `GET /internal/parking`. `server.ts` mounts `handleActionRoute` and
 * `handleParkingRead`; the actions themselves are `calls/actions.ts`'s `CallActions`.
 */
import type http from 'node:http';

import { HTTP_OK } from '@zamfono/shared';

import { ActionError } from '../calls/actionError.js';
import type { CallActions } from '../calls/actions.js';
import {
  CALL_ROUTES,
  ORIGINATE_ROUTE,
  type ActionRoute
} from './actionTable.js';
import {
  readJsonBody,
  respondInvalidBody,
  respondJson,
  respondProblem
} from './http.js';

const CALL_ACTION_ROUTE =
  /^\/internal\/calls\/(?<callId>[^/]+)\/(?<action>[^/]+)$/u;

/** The route `pathname` names, a call action's bound to its call; `null` off every action
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
  return route(callId);
}

/**
 * Serves one action `POST` with `route`'s body. A refused action (`ActionError`) answers its
 * status as a problem whose `detail` is the cause, where `api`'s core client reads it (§10.2
 * `noRegisteredDevice`).
 */
async function serveAction(
  actions: CallActions,
  route: ActionRoute,
  response: http.ServerResponse,
  request: http.IncomingMessage
): Promise<void> {
  const parsed = await readJsonBody(request, response);
  if (parsed === null) {
    return;
  }
  // An empty body is an action with no fields.
  const accepted = route(parsed.body === undefined ? {} : parsed.body);
  if (accepted === null) {
    respondInvalidBody(response);
    return;
  }
  try {
    const answer = await accepted(actions);
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
}

/** Serves an action `POST`; `null` when `pathname` names no action route. */
export function handleActionRoute(
  { actions }: { actions: CallActions },
  pathname: string,
  response: http.ServerResponse,
  request: http.IncomingMessage
): Promise<void> | null {
  const route = matchActionRoute(pathname);
  return route === null ? null : serveAction(actions, route, response, request);
}

/** `GET /internal/parking` (§10.2 "Call parking"): the occupied slots. */
export async function handleParkingRead(
  { actions }: { actions: CallActions },
  response: http.ServerResponse
): Promise<void> {
  respondJson(response, HTTP_OK, await actions.parked());
}
