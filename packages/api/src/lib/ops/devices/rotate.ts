import { z } from 'zod';

import { encrypt, keyringFromEnv } from '../../secretbox.js';
import { newSipPassword } from '../../sip.js';
import { propagate, recordChange } from '../runner.js';
import { defineOperation } from '../types.js';
import { pushToRingotel } from './_ringotelPush.js';
import { liveDevice } from './_shared.js';

/** `POST /devices/{id}/rotate` (§5.2): a new SIP password, for a credential suspected leaked. */
export const rotate = defineOperation({
  name: 'devices.rotate',
  description: "Rotates a device's SIP password.",
  input: z.object({ id: z.string() }).strict(),
  minRole: 'admin',
  confirm: input => `Rotate the SIP password of device '${input.id}'?`,
  entity: input => ({ kind: 'device', id: input.id }),
  run: async (ctx, input) => {
    const row = await liveDevice(ctx.db, input.id);
    const password = newSipPassword();
    await ctx.db
      .updateTable('devices')
      .set({ sipPasswordEnc: encrypt(keyringFromEnv(process.env), password) })
      .where('id', '=', input.id)
      .execute();
    recordChange(ctx, { field: 'sipPassword', from: null, to: password });
    propagate(ctx, ['pjsip']);
    if (row.kind === 'ringotel') {
      pushToRingotel(ctx, {
        trigger: 'devices.rotate',
        deviceId: input.id,
        push: provider =>
          provider.onCredentialsRotated(row, {
            username: row.sipUsername,
            password
          }),
        failure: {
          what: `device ${input.id}'s new password is stored`,
          retry: 'rotating again retries it'
        }
      });
    }
    return { sipUsername: row.sipUsername, sipPassword: password };
  }
});
