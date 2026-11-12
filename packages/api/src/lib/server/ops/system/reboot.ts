import * as env from '$app/env/private';
import { z } from 'zod';

import {
  HTTP_CONFLICT,
  HTTP_NOT_FOUND,
  HTTP_SERVICE_UNAVAILABLE
} from '@zamfono/shared';

import { errorMessage } from '#lib/server/errors.js';
import { runHostPassNow } from '#lib/server/jobs/host.js';

import { afterCommit } from '../afterCommit.js';
import { recordChange, setUndoable } from '../audit.js';
import { defineOperation, OpError } from '../types.js';
import { setRebootRequest } from './_host.js';
import { hostClient, UpdaterRefusal, type HostClient } from './_updater.js';

const WHEN = ['now', 'maintenance'] as const;

/** A refusal keeps its status where it is a conflict or not found, else 503. */
function passOn(error: unknown): never {
  if (
    error instanceof UpdaterRefusal &&
    (error.status === HTTP_CONFLICT || error.status === HTTP_NOT_FOUND)
  ) {
    throw new OpError(error.status, `system.reboot: ${error.message}`);
  }
  throw new OpError(
    HTTP_SERVICE_UNAVAILABLE,
    `system.reboot: ${errorMessage(error)}`
  );
}

function client(): HostClient {
  const host = hostClient();
  if (host === undefined) {
    throw new OpError(HTTP_NOT_FOUND, "unknown operation 'system.reboot'");
  }
  return host;
}

/**
 * `POST /system/reboot` (§6.3 "Host control", §10.3): reboots the host the stack runs on, now or
 * at the next maintenance moment once nothing is in progress (`jobs/host.ts`); a later `now`
 * drops a scheduled one. Offered only while `.env` sets `HOST_CONTROL=true`; refused while an update runs, and on Podman without the stack's boot unit,
 * since the stack would not start again. Not undoable.
 */
export const reboot = defineOperation({
  name: 'system.reboot',
  description:
    "Reboots the host the stack runs on: now, dropping every call, or at the next maintenance moment once no call is in progress; system.info's host.rebootRequired says when the host waits for one.",
  available: () => env.HOST_CONTROL,
  input: z
    .object({
      when: z
        .enum(WHEN)
        .describe(
          'now, or maintenance: the next maintenance moment once nothing is in progress, as the automatic update waits.'
        )
    })
    .strict(),
  output: z.object({ when: z.enum(WHEN) }),
  problems: [HTTP_CONFLICT, HTTP_NOT_FOUND, HTTP_SERVICE_UNAVAILABLE],
  minRole: 'owner',
  pureAction: true,
  confirm: (_ctx, input) =>
    input.when === 'now'
      ? 'Reboot the host now? Every call drops, and the stack is back once the host has started again.'
      : 'Reboot the host at the next maintenance moment, once no call is in progress?',
  entity: () => ({ kind: 'system', id: null }),
  run: async (ctx, input) => {
    setUndoable(ctx, false);
    // The audit entry says which: now, or at the next maintenance moment.
    recordChange(ctx, { field: 'when', from: null, to: input.when });
    const host = client();
    if (input.when === 'now') {
      await host.reboot().catch(passOn);
      await setRebootRequest(ctx.db, null);
      return { when: input.when };
    }
    const { rebootRefused } = await host.read().catch(passOn);
    if (rebootRefused !== undefined) {
      throw new OpError(HTTP_CONFLICT, `system.reboot: ${rebootRefused}`);
    }
    await setRebootRequest(ctx.db, { at: ctx.now, by: ctx.actor.name });
    afterCommit(ctx, async () => {
      runHostPassNow();
      return Promise.resolve(null);
    });
    return { when: input.when };
  }
});
