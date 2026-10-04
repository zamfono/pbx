import * as env from '$app/env/private';
import { z } from 'zod';

import { HTTP_NOT_FOUND } from '@zamfono/shared';

import { decrypt, keyringFromEnv } from '#lib/server/secretbox.js';

import { setUndoable } from '../audit.js';
import { defineOperation } from '../types.js';
import {
  connectionSettings,
  connectionSettingsOut
} from './_connectionSettings.js';
import { liveDevice, sipCredentialsOut } from './_shared.js';

/**
 * `GET /devices/{id}/credentials` (§5.2): reveals a device's SIP credentials, audited, never
 * undoable; a `manual` device's as its full connection settings (§10.4 "`manual`").
 */
export const revealCredentials = defineOperation({
  name: 'devices.revealCredentials',
  description:
    "Reveals a device's SIP credentials; a manual device's as its full connection settings.",
  input: z.object({ id: z.string() }).strict(),
  output: z.union([connectionSettingsOut, sipCredentialsOut]),
  problems: [HTTP_NOT_FOUND],
  minRole: 'admin',
  pureAction: true,
  entity: input => ({ kind: 'device', id: input.id }),
  run: async (ctx, input) => {
    const row = await liveDevice(ctx.db, input.id);
    setUndoable(ctx, false);
    const password = decrypt(keyringFromEnv(env), row.sipPasswordEnc).toString(
      'utf8'
    );
    if (row.kind === 'manual') {
      return connectionSettings(ctx.db, row, password);
    }
    return { sipUsername: row.sipUsername, sipPassword: password };
  }
});
