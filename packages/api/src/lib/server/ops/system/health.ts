import { z } from 'zod';

import { healthDocumentSchema } from '@zamfono/shared';

import { currentHealth } from '#lib/server/health.js';

import { defineOperation } from '../types.js';

/**
 * `GET /system/health` (§6.3 "Health", §10.3 "System"): the health document with its checks,
 * which `/healthz` shows only to the bearer of `METRICS_TOKEN`, since they tell which protection
 * or job is down. A check that fails to answer rejects, as it fails `/healthz` with 500.
 */
export const health = defineOperation({
  name: 'system.health',
  description:
    "Reads the stack's health document as /healthz computes it: the overall status (pass, warn or fail) and each check's status, keyed <component>:<measurement>, such as database:status, core:reachable, certificate:sync, sipBan:helper, trunks:emergency, mail:relay, config:propagation or update:automatic, with observedValue, output and time where a check says more.",
  input: z.object({}).strict(),
  output: healthDocumentSchema,
  minRole: 'admin',
  readOnly: true,
  run: async ctx => currentHealth(() => ctx.db)
});
