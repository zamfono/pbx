import { z } from 'zod';

import {
  HTTP_CONFLICT,
  HTTP_NOT_FOUND,
  HTTP_SERVICE_UNAVAILABLE
} from '@zamfono/shared';

import { getCoreClient } from '#lib/server/coreClient.js';

import { setUndoable } from '../audit.js';
import { defineOperation, OpError } from '../types.js';
import { liveTrunk } from './_shared.js';

const inputSchema = z.object({ id: z.string().min(1) }).strict();

/**
 * `POST /trunks/{id}/reregister` (§9.4 "Provisioning and status", §10.3): `core` has Asterisk
 * unregister the `registration` trunk and register it afresh, answering once Asterisk queued
 * both; the trunk's `status` and `registeredAt` show the outcome. An audited pure action, not
 * undoable (§5.8).
 */
export const reregister = defineOperation({
  name: 'trunks.reregister',
  description:
    "Has a registration trunk unregister and register afresh with its provider; trunks.get's status and registeredAt show the outcome. Refused for an ip trunk.",
  input: inputSchema,
  output: z.object({ id: z.string() }),
  problems: [HTTP_NOT_FOUND, HTTP_CONFLICT, HTTP_SERVICE_UNAVAILABLE],
  minRole: 'admin',
  writesDatabase: false,
  pureAction: true,
  entity: input => ({ kind: 'trunk', id: input.id }),
  run: async (ctx, input) => {
    const trunk = await liveTrunk(ctx.db, input.id);
    if (trunk.authMode !== 'registration') {
      throw new OpError(
        HTTP_CONFLICT,
        'trunk has no registration',
        'noRegistration'
      );
    }
    setUndoable(ctx, false);
    await getCoreClient().reregisterTrunk(input.id);
    return { id: input.id };
  }
});
