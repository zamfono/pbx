import { env } from '$env/dynamic/private';
import { z } from 'zod';

import { decrypt, keyringFromEnv } from '$lib/server/secretbox.js';

import { setUndoable } from '../runner.js';
import { defineOperation } from '../types.js';
import { liveDevice } from './_shared.js';

/** `GET /devices/{id}/credentials` (§5.2): reveals a device's SIP credentials, audited, never undoable. */
export const revealCredentials = defineOperation({
  name: 'devices.revealCredentials',
  description: "Reveals a device's SIP credentials.",
  input: z.object({ id: z.string() }).strict(),
  minRole: 'admin',
  pureAction: true,
  entity: input => ({ kind: 'device', id: input.id }),
  run: async (ctx, input) => {
    const row = await liveDevice(ctx.db, input.id);
    setUndoable(ctx, false);
    return {
      sipUsername: row.sipUsername,
      sipPassword: decrypt(keyringFromEnv(env), row.sipPasswordEnc).toString(
        'utf8'
      )
    };
  }
});
