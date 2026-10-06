import type { z } from 'zod';

import { HTTP_SERVICE_UNAVAILABLE } from '@zamfono/shared';

import { errorMessage } from '#lib/server/errors.js';

import { OpError } from '../types.js';
import { updaterClient, UpdaterRefusal } from './_updater.js';
import type { updateOut } from './_wire.js';

/**
 * The `update` block of `system.info` and `system.checkUpdate` (§6.3 "Updates", §10.3): the
 * updater's status, `fresh` from GitHub now, or why there is none. A refusal with `Retry-After`,
 * GitHub's spent rate limit on a fresh look, is a 503 that passes on when to retry.
 */
export async function updateStatus(
  fresh = false
): Promise<z.infer<typeof updateOut>> {
  const client = updaterClient();
  if (client === undefined) {
    return {
      unavailable:
        'UPDATER_TOKEN is not set in .env; updates run only by update.sh on the host'
    };
  }
  try {
    return await client.status(fresh);
  } catch (error) {
    if (error instanceof UpdaterRefusal && error.retryAfterS !== undefined) {
      const { retryAfterS } = error;
      throw new OpError(
        HTTP_SERVICE_UNAVAILABLE,
        `system.checkUpdate: ${error.message}`,
        { retryAfterS },
        { 'retry-after': String(retryAfterS) }
      );
    }
    return {
      unavailable: `the updater did not answer: ${errorMessage(error)}`
    };
  }
}
