/**
 * What each live-call action of the internal API is (§3, §10.3 "Live calls"): the schema of its
 * request (`internalApi.ts`), the `CallActions` method it runs and what it answers.
 * `actionRoutes.ts` serves them.
 */
import type { z } from 'zod';

import {
  addPartyRequestSchema,
  attendedTransferRequestSchema,
  consultRequestSchema,
  declineRequestSchema,
  hangupRequestSchema,
  holdRequestSchema,
  HTTP_CONFLICT,
  HTTP_CREATED,
  HTTP_NO_CONTENT,
  HTTP_OK,
  originateRequestSchema,
  parkRequestSchema,
  pickupRequestSchema,
  transferRequestSchema
} from '@zamfono/shared';

import { ActionError } from '../calls/actionError.js';
import type { CallActions } from '../calls/actions.js';

type Answer = { status: number; body?: unknown };

/** An action whose request body its schema accepted, ready to run. */
type AcceptedAction = (actions: CallActions) => Promise<Answer>;

/** One action's route: its request body, parsed by the action's schema, as the action to run;
 * `null` for a body the schema refuses. */
export type ActionRoute = (body: unknown) => AcceptedAction | null;

/** The route that parses its body with `schema` and runs `run` with it. */
function route<T>(
  schema: z.ZodType<T>,
  run: (actions: CallActions, body: T) => Promise<Answer>
): ActionRoute {
  return body => {
    const parsed = schema.safeParse(body);
    return parsed.success ? actions => run(actions, parsed.data) : null;
  };
}

const NO_CONTENT = { status: HTTP_NO_CONTENT };

/** `POST /internal/calls/{id}/{action}`, by action, each the route on the call `callId` names:
 * park answers its slot, the two that dial a call (`parties`, `consult`) 201 with its id, every
 * other 204. */
export const CALL_ROUTES: Record<string, (callId: string) => ActionRoute> = {
  transfer: callId =>
    route(transferRequestSchema, async (actions, body) => {
      await actions.transfer(callId, body);
      return NO_CONTENT;
    }),
  pickup: callId =>
    route(pickupRequestSchema, async (actions, body) => {
      await actions.pickup(callId, body);
      return NO_CONTENT;
    }),
  hangup: callId =>
    route(hangupRequestSchema, async (actions, body) => {
      await actions.hangup(callId, body);
      return NO_CONTENT;
    }),
  park: callId =>
    route(parkRequestSchema, async (actions, body) => ({
      status: HTTP_OK,
      body: await actions.park(callId, body)
    })),
  parties: callId =>
    route(addPartyRequestSchema, async (actions, body) => ({
      status: HTTP_CREATED,
      body: await actions.addParty(callId, body)
    })),
  consult: callId =>
    route(consultRequestSchema, async (actions, body) => ({
      status: HTTP_CREATED,
      body: await actions.consult(callId, body)
    })),
  attendedTransfer: callId =>
    route(attendedTransferRequestSchema, async (actions, body) => {
      await actions.attendedTransfer(callId, body);
      return NO_CONTENT;
    }),
  hold: callId =>
    route(holdRequestSchema, async (actions, body) => {
      await actions.hold(callId, body);
      return NO_CONTENT;
    }),
  resume: callId =>
    route(holdRequestSchema, async (actions, body) => {
      await actions.resume(callId, body);
      return NO_CONTENT;
    }),
  decline: callId =>
    route(declineRequestSchema, (actions, body) => {
      actions.decline(callId, body);
      return Promise.resolve(NO_CONTENT);
    })
};

/** `POST /internal/calls` (§10.2 "Click-to-dial"): a refused originate answers 409 with its
 * cause, `noRegisteredDevice`, else 201 with the call's id. */
export const ORIGINATE_ROUTE: ActionRoute = route(
  originateRequestSchema,
  async (actions, body) => {
    const result = await actions.originate(body);
    if ('error' in result) {
      throw new ActionError(
        HTTP_CONFLICT,
        result.error,
        'no registered device'
      );
    }
    return { status: HTTP_CREATED, body: result };
  }
);
