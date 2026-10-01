/** The refusal the live-call actions of the internal API raise (`actions.ts`, §3), its own module
 * so the modules an action delegates to raise it too. */

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
