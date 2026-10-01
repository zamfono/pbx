/**
 * The call-control routes of the internal API (§3, §10.3 "Live calls"):
 * `POST /internal/calls/{id}/{parties|consult|attendedTransfer|hold|resume|decline}`, beside
 * `actionRoutes.ts`'s originate, transfer, pickup and hangup, whose body checks and problem
 * answers they share. `server.ts` mounts `handleCallControlRoute`; the actions themselves are
 * `calls/callControl.ts`'s, reached through `calls/actions.ts`'s `CallActions`.
 */
import type http from 'node:http';

import type {
  AddPartyRequest,
  AttendedTransferRequest,
  ConsultRequest,
  DeclineRequest,
  HoldRequest
} from '@zamfono/shared';

import {
  isActionFailure,
  readActionBody,
  respondProblem
} from './actionRoutes.js';
import { respondJson } from './configChanged.js';

const HTTP_CREATED = 201;
const HTTP_NO_CONTENT = 204;
const HTTP_BAD_REQUEST = 400;
const ROUTE =
  /^\/internal\/calls\/(?<callId>[^/]+)\/(?<action>parties|consult|attendedTransfer|hold|resume|decline)$/u;
// The string fields each action's request carries (`internalApi.ts`).
const FIELDS = {
  parties: ['target', 'actorUserId'],
  consult: ['target', 'actorUserId'],
  attendedTransfer: ['toCallId', 'actorUserId'],
  hold: ['actorUserId'],
  resume: ['actorUserId'],
  decline: ['actorUserId']
} as const;
type Action = keyof typeof FIELDS;

/** The call-control actions `CallActions` offers (`server.ts`). */
export type CallControlActions = {
  addParty: (
    callId: string,
    req: AddPartyRequest
  ) => Promise<{ callId: string }>;
  consult: (callId: string, req: ConsultRequest) => Promise<{ callId: string }>;
  attendedTransfer: (
    callId: string,
    req: AttendedTransferRequest
  ) => Promise<void>;
  hold: (callId: string, req: HoldRequest) => Promise<void>;
  resume: (callId: string, req: HoldRequest) => Promise<void>;
  decline: (callId: string, req: DeclineRequest) => void;
};

function isAction(action: string): action is Action {
  return Object.hasOwn(FIELDS, action);
}

/** Runs `action`; the call it started, for the two that dial one, else `null`. */
async function run(
  actions: CallControlActions,
  callId: string,
  action: Action,
  body: Record<string, unknown>
): Promise<{ callId: string } | null> {
  switch (action) {
    case 'parties':
      return actions.addParty(callId, body as AddPartyRequest);
    case 'consult':
      return actions.consult(callId, body as ConsultRequest);
    case 'attendedTransfer':
      await actions.attendedTransfer(callId, body as AttendedTransferRequest);
      return null;
    case 'hold':
      await actions.hold(callId, body as HoldRequest);
      return null;
    case 'resume':
      await actions.resume(callId, body as HoldRequest);
      return null;
    default:
      actions.decline(callId, body as DeclineRequest);
      return null;
  }
}

/**
 * Serves one call-control `POST`; `false` when `pathname` names none of these routes, or the
 * actions are not mounted. A refused action answers its status as a problem whose `detail` is
 * the cause, as `actionRoutes.ts`'s do; the two that dial a call answer 201 with its id.
 */
export async function handleCallControlRoute(
  actions: CallControlActions | null,
  pathname: string,
  request: http.IncomingMessage,
  response: http.ServerResponse
): Promise<boolean> {
  const groups = ROUTE.exec(pathname)?.groups;
  const callId = groups?.callId;
  const action = groups?.action;
  if (
    actions === null ||
    callId === undefined ||
    action === undefined ||
    !isAction(action)
  ) {
    return false;
  }
  const body = await readActionBody(request);
  const fields: readonly string[] = FIELDS[action];
  if (
    body === null ||
    !fields.every(field => typeof body[field] === 'string')
  ) {
    respondJson(response, HTTP_BAD_REQUEST, { message: 'invalid body' });
    return true;
  }
  try {
    const started = await run(actions, callId, action, body);
    if (started === null) {
      response.writeHead(HTTP_NO_CONTENT);
      response.end();
    } else {
      respondJson(response, HTTP_CREATED, started);
    }
  } catch (error) {
    if (!isActionFailure(error)) {
      throw error;
    }
    respondProblem(response, error.status, error.message, error.reason);
  }
  return true;
}
