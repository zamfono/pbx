/**
 * What each live-call action of the internal API is (§3, §10.3 "Live calls"): the fields its
 * request carries, the `CallActions` method it runs and what it answers. `actionRoutes.ts` serves
 * them.
 */
import type {
  AddPartyRequest,
  AttendedTransferRequest,
  ConsultRequest,
  DeclineRequest,
  HangupRequest,
  HoldRequest,
  OriginateRequest,
  ParkRequest,
  PickupRequest,
  TransferRequest
} from '@zamfono/shared';

import { ActionError } from '../calls/actionError.js';
import type { CallActions } from '../calls/actions.js';

const HTTP_OK = 200;
const HTTP_CREATED = 201;
const HTTP_NO_CONTENT = 204;
const HTTP_CONFLICT = 409;

export type Body = Record<string, unknown>;
type Answer = { status: number; body?: unknown };

/** One action's route: the string fields its request carries (`internalApi.ts`), the optional
 * ones that are absent or a boolean, and its run, answering its status and body. */
export type ActionRoute = {
  fields: readonly string[];
  flags?: readonly string[];
  run: (actions: CallActions, body: Body) => Promise<Answer>;
};

/** An action on the call `callId` names. */
type CallRoute = Omit<ActionRoute, 'run'> & {
  run: (actions: CallActions, callId: string, body: Body) => Promise<Answer>;
};

const NO_CONTENT = { status: HTTP_NO_CONTENT };

/** `POST /internal/calls/{id}/{action}`, by action: park answers its slot, the two that dial a
 * call (`parties`, `consult`) 201 with its id, every other 204. */
export const CALL_ROUTES: Record<string, CallRoute> = {
  transfer: {
    fields: ['target', 'actorUserId'],
    // A transfer to the target's mailbox (§10.1 "Transfers and pickup").
    flags: ['voicemail'],
    run: async (actions, callId, body) => {
      await actions.transfer(callId, body as TransferRequest);
      return NO_CONTENT;
    }
  },
  pickup: {
    fields: ['userId', 'actorUserId'],
    run: async (actions, callId, body) => {
      await actions.pickup(callId, body as PickupRequest);
      return NO_CONTENT;
    }
  },
  hangup: {
    fields: ['actorUserId'],
    run: async (actions, callId, body) => {
      await actions.hangup(callId, body as HangupRequest);
      return NO_CONTENT;
    }
  },
  park: {
    fields: ['userId', 'actorUserId'],
    run: async (actions, callId, body) => ({
      status: HTTP_OK,
      body: await actions.park(callId, body as ParkRequest)
    })
  },
  parties: {
    fields: ['target', 'actorUserId'],
    run: async (actions, callId, body) => ({
      status: HTTP_CREATED,
      body: await actions.addParty(callId, body as AddPartyRequest)
    })
  },
  consult: {
    fields: ['target', 'actorUserId'],
    run: async (actions, callId, body) => ({
      status: HTTP_CREATED,
      body: await actions.consult(callId, body as ConsultRequest)
    })
  },
  attendedTransfer: {
    fields: ['toCallId', 'actorUserId'],
    run: async (actions, callId, body) => {
      await actions.attendedTransfer(callId, body as AttendedTransferRequest);
      return NO_CONTENT;
    }
  },
  hold: {
    fields: ['actorUserId'],
    run: async (actions, callId, body) => {
      await actions.hold(callId, body as HoldRequest);
      return NO_CONTENT;
    }
  },
  resume: {
    fields: ['actorUserId'],
    run: async (actions, callId, body) => {
      await actions.resume(callId, body as HoldRequest);
      return NO_CONTENT;
    }
  },
  decline: {
    fields: ['actorUserId'],
    run: (actions, callId, body) => {
      actions.decline(callId, body as DeclineRequest);
      return Promise.resolve(NO_CONTENT);
    }
  }
};

/** `POST /internal/calls` (§10.2 "Click-to-dial"): a refused originate answers 409 with its
 * cause, `noRegisteredDevice`, else 201 with the call's id. */
export const ORIGINATE_ROUTE: ActionRoute = {
  fields: ['userId', 'target', 'actorUserId', 'requestId'],
  // The call's own CLIR (§9.4 "Anonymous calls (CLIR)").
  flags: ['clir'],
  run: async (actions, body) => {
    const result = await actions.originate(body as OriginateRequest);
    if ('error' in result) {
      throw new ActionError(
        HTTP_CONFLICT,
        result.error,
        'no registered device'
      );
    }
    return { status: HTTP_CREATED, body: result };
  }
};
