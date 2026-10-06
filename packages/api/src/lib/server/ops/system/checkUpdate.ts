import { z } from 'zod';

import { HTTP_SERVICE_UNAVAILABLE } from '@zamfono/shared';

import { defineOperation } from '../types.js';
import { updateStatus } from './_status.js';
import { updateOut } from './_wire.js';

/**
 * `POST /system/updateCheck` (§6.3 "Updates", §10.3): has the updater ask GitHub for the latest
 * release now rather than within its hour, at most once a minute, and answers with the `update`
 * block `system.info` reads from the refreshed cache. A spent GitHub rate limit is a 503 with
 * `Retry-After`.
 */
export const checkUpdate = defineOperation({
  name: 'system.checkUpdate',
  description:
    'Has the updater ask GitHub for the latest release now, at most once a minute (else it answers from its cache), and reads the update block system.info carries; a spent GitHub rate limit answers 503 with retryAfterS.',
  input: z.object({}).strict(),
  output: updateOut,
  problems: [HTTP_SERVICE_UNAVAILABLE],
  minRole: 'admin',
  readOnly: true,
  run: async () => updateStatus(true)
});
