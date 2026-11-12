import * as env from '$app/env/private';
import { z } from 'zod';

import { HTTP_NOT_FOUND } from '@zamfono/shared';

import { runHostPassNow } from '#lib/server/jobs/host.js';

import { defineOperation } from '../types.js';
import { hostOut, hostStatus } from './_host.js';

/**
 * `POST /system/hostCheck` (§6.3 "Host control", §10.3): has the host agent read the host now
 * rather than within its ten minutes, answers with the `host` block `system.info` reads, and runs
 * `api`'s own host pass at once, which `/metrics` and the reboot and upgrades follow. Offered only
 * while `.env` sets `HOST_CONTROL=true`.
 */
export const checkHost = defineOperation({
  name: 'system.checkHost',
  description:
    "Has the host agent read the host now, whether it waits for a reboot among it, and answers with the host block system.info carries; Zamfono's own reading, which /metrics and an automatic reboot follow, is refreshed with it.",
  available: () => env.HOST_CONTROL,
  input: z.object({}).strict(),
  output: hostOut,
  // Unknown without HOST_CONTROL.
  problems: [HTTP_NOT_FOUND],
  minRole: 'admin',
  readOnly: true,
  run: async ctx => {
    const host = await hostStatus(ctx.db, async client => client.check());
    runHostPassNow();
    return host;
  }
});
