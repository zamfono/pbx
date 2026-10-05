import * as env from '$app/env/private';
import { z } from 'zod';

import { HTTP_NOT_FOUND } from '@zamfono/shared';

import { storedCredentials } from '#lib/server/provisioning/ringotelUser.js';
import { encrypt, keyringFromEnv } from '#lib/server/secretbox.js';
import { newSipPassword } from '#lib/server/sip.js';

import { recordChange } from '../audit.js';
import { propagate } from '../propagate.js';
import { defineOperation } from '../types.js';
import { pushToRingotel } from './_ringotelPush.js';
import { liveDevice, sipCredentialsOut } from './_shared.js';

/** `POST /devices/{id}/rotate` (§5.2): a new SIP password, for a credential suspected leaked. */
export const rotate = defineOperation({
  name: 'devices.rotate',
  description: "Rotates a device's SIP password.",
  input: z.object({ id: z.string() }).strict(),
  output: sipCredentialsOut,
  problems: [HTTP_NOT_FOUND],
  minRole: 'admin',
  confirm: async (ctx, input) =>
    `Rotate the SIP password of the device ${(await liveDevice(ctx.db, input.id)).label}? It stops registering until it has the new one.`,
  entity: input => ({ kind: 'device', id: input.id }),
  run: async (ctx, input) => {
    const row = await liveDevice(ctx.db, input.id);
    const password = newSipPassword();
    await ctx.db
      .updateTable('devices')
      .set({
        sipPasswordEnc: encrypt(
          keyringFromEnv(env),
          'devices.sipPasswordEnc',
          password
        )
      })
      .where('id', '=', input.id)
      .execute();
    recordChange(ctx, { field: 'sipPassword', from: null, to: password });
    propagate(ctx, ['pjsip']);
    if (row.kind === 'ringotel') {
      pushToRingotel(ctx, {
        trigger: 'devices.rotate',
        deviceId: input.id,
        push: (provider, device) =>
          provider.onCredentialsRotated(device, storedCredentials(device)),
        failure: {
          what: `device ${input.id}'s new password is stored`,
          retry: 'rotating again retries it'
        }
      });
    }
    return { sipUsername: row.sipUsername, sipPassword: password };
  }
});
