/** The refusal the live-call actions of the internal API raise (`actions.ts`, §3), its own module
 * so the modules an action delegates to raise it too, with the statuses they refuse with. */

export const HTTP_NOT_FOUND = 404;
export const HTTP_CONFLICT = 409;
export const HTTP_UNPROCESSABLE = 422;

/** A refused action, carried to the internal API as its HTTP status and problem `cause`. */
export class ActionError extends Error {
  readonly status: number;
  readonly reason: string;

  constructor(status: number, reason: string, message: string) {
    super(message);
    this.name = 'ActionError';
    this.status = status;
    this.reason = reason;
  }
}

/** The refusal of an action that needs the call's own two-party conversation (`bridgedParty`). */
export function notBridged(): ActionError {
  return new ActionError(HTTP_CONFLICT, 'notBridged', 'call is not bridged');
}
