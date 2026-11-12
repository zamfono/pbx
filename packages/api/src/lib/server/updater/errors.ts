import { HTTP_CONFLICT, HTTP_SERVICE_UNAVAILABLE } from '@zamfono/shared';

import { AgentRefusal } from './agent.js';

/**
 * A refusal of the update or host machinery (§6.3 "Updates" and "Host control"): the HTTP status
 * the operations layer answers with where it has it, the message, and on a spent GitHub rate limit
 * when to ask again, in seconds.
 */
export class UpdaterRefusal extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly retryAfterS?: number
  ) {
    super(message);
  }
}

/** The agent's refusal to take a request, as `api` answers it. */
export function passOnRefusal(error: unknown): never {
  if (error instanceof AgentRefusal) {
    throw new UpdaterRefusal(
      error.reason === 'notTaken' ? HTTP_SERVICE_UNAVAILABLE : HTTP_CONFLICT,
      error.message
    );
  }
  throw error;
}
