import { z } from 'zod';

import {
  HTTP_BAD_REQUEST,
  HTTP_NOT_FOUND,
  HTTP_SERVICE_UNAVAILABLE
} from '@zamfono/shared';

import { setUndoable } from '../audit.js';
import { defineOperation } from '../types.js';
import { requestUpdate } from './_request.js';
import { updateStateOut } from './_wire.js';

const inputSchema = z
  .object({
    version: z
      .string()
      .regex(/^\d+\.\d+\.\d+$/u)
      .optional()
      .describe(
        'The release to update to, such as 0.2.0; left out, the latest (see zamfono.help update-stack).'
      ),
    breaking: z
      .boolean()
      .optional()
      .describe(
        'true takes a breaking release (update.breaking in system.info), once its upgrade notes at update.latest.url have been read and need nothing done on the host; refused without it.'
      )
  })
  .strict();

/**
 * `POST /system/update` (§6.3 "Updates", §10.3): has the updater service take the stack to the
 * latest release, or to `version`, when that release is newer and non-breaking, or breaking and
 * `breaking` is set. Refused unless a
 * backup run finished `ok` within the last hour, so the update begins from a restorable point;
 * answers as soon as the updater has begun, and `system.info` reports how it went and who asked.
 * Not undoable: migrations only go forward (§6.3 "Upgrades").
 */
export const update = defineOperation({
  name: 'system.update',
  description:
    'Updates the stack to the latest release, or to version, if newer and non-breaking, or breaking with breaking: true once its upgrade notes were read; needs a backup run finished ok within the last hour. system.info reports the progress.',
  input: inputSchema,
  output: updateStateOut,
  // The updater's own refusals keep their status; anything else, or no updater, is a 503.
  problems: [HTTP_BAD_REQUEST, HTTP_NOT_FOUND, HTTP_SERVICE_UNAVAILABLE],
  minRole: 'owner',
  pureAction: true,
  confirm: (_ctx, input) =>
    `Update the stack to ${input.version ?? 'the latest release'}${input.breaking === true ? ', even a breaking release, whose upgrade notes you have read' : ''}? Calls drop while it restarts, and only a restore from the backup undoes it.`,
  entity: () => ({ kind: 'system', id: null }),
  run: async (ctx, input) => {
    setUndoable(ctx, false);
    return requestUpdate(
      ctx.db,
      ctx.now,
      input.version,
      {
        trigger: 'manual',
        by: ctx.actor.name,
        breaking: input.breaking === true
      },
      null
    );
  }
});
