import { env } from '$env/dynamic/private';
import { z } from 'zod';

import { newId } from '@zamfono/shared';

import { encrypt, keyringFromEnv } from '$lib/server/secretbox.js';
import { newSipPassword } from '$lib/server/sip.js';

import { propagate, recordChange } from '../runner.js';
import { defineOperation, OpError } from '../types.js';
import { userExtension } from '../users/_extensions.js';
import { liveUser } from '../users/_shared.js';
import { pushToRingotel } from './_ringotelPush.js';
import {
  assertDeviceCreateScope,
  assertNoExistingRingotelDevice,
  DEVICE_KINDS,
  liveDevice,
  STATUS_UNPROCESSABLE_ENTITY,
  toDeviceOut,
  TRANSPORTS
} from './_shared.js';
import { uniqueSipUsername } from './_sipUsername.js';
import {
  assertKindTransport,
  assertNonEmptyIps,
  assertPlainTransportEnabled,
  assertValidIps
} from './_transportPolicy.js';

const inputSchema = z
  .object({
    userId: z.string(),
    label: z.string().min(1),
    kind: z
      .enum(DEVICE_KINDS)
      .describe(
        "manual: a softphone or desk phone configured by hand with the returned credentials; ringotel: the user's Ringotel app account, at most one per user (see zamfono.help ringotel-setup)."
      ),
    transport: z
      .enum(TRANSPORTS)
      .optional()
      .describe(
        'tls (the default): SIP over TLS from anywhere; plain: UDP or TCP from allowedIps only, manual devices alone (see zamfono.help remote-workers).'
      ),
    allowedIps: z
      .array(z.string())
      .optional()
      .describe(
        'IPs or CIDR ranges, IPv4 or IPv6, the only sources a plain device may register and call from; required for plain, refused for tls.'
      )
  })
  .strict();
/**
 * "The response that creates a `manual` device returns the SIP credentials; for a provisioned
 * device they are pushed to the provider" (§5.2): a `ringotel` device's response carries only the
 * device, and an admin reveals its credentials later through `devices.revealCredentials`.
 */
type Output = {
  device: ReturnType<typeof toDeviceOut>;
  sipUsername?: string;
  sipPassword?: string;
  /** A `ringotel` device Ringotel refused, or no Ringotel setup: the device stands, and this says why (§10.4). */
  warnings?: string[];
};

/** `POST /users/{id}/devices` (§10.3, §9.3): creates a SIP device, returning a manual one's credentials once. */
export const create = defineOperation({
  name: 'devices.create',
  description:
    "Creates a SIP device for a user; a manual device's credentials are returned once.",
  input: inputSchema,
  minRole: 'user',
  entity: (_input, out: Output) => ({ kind: 'device', id: out.device.id }),
  run: async (ctx, input) => {
    const transport = input.transport ?? 'tls';
    assertDeviceCreateScope(
      ctx.actor.role,
      ctx.actor.id,
      input.userId,
      transport
    );
    await liveUser(ctx.db, input.userId);
    assertKindTransport(input.kind, transport);
    if (transport === 'plain') {
      assertPlainTransportEnabled();
      assertNonEmptyIps(input.allowedIps ?? []);
      assertValidIps(input.allowedIps ?? []);
    } else if (input.allowedIps !== undefined) {
      throw new OpError(
        STATUS_UNPROCESSABLE_ENTITY,
        'devices: allowedIps applies only to a plain device'
      );
    }
    if (input.kind === 'ringotel') {
      await assertNoExistingRingotelDevice(ctx.db, input.userId);
    }
    const ext = await userExtension(ctx.db, input.userId);
    const username = await uniqueSipUsername(ctx.db, ext);
    const password = newSipPassword();
    const id = newId();
    await ctx.db
      .insertInto('devices')
      .values({
        id,
        userId: input.userId,
        label: input.label,
        kind: input.kind,
        transport,
        allowedIpsJson:
          transport === 'plain' ? JSON.stringify(input.allowedIps) : null,
        sipUsername: username,
        sipPasswordEnc: encrypt(keyringFromEnv(env), password),
        createdAt: ctx.now
      })
      .execute();
    // No `sipPassword` diff entry: masking it would mark the whole creation non-undoable
    // (§5.8), and unlike `devices.rotate` a creation has no prior state to lose by reverting.
    recordChange(ctx, { field: 'label', from: null, to: input.label });
    propagate(ctx, ['pjsip']);
    const row = await liveDevice(ctx.db, id);
    if (input.kind === 'ringotel') {
      pushToRingotel(ctx, {
        trigger: 'devices.create',
        deviceId: id,
        push: provider => provider.onDeviceCreated(row, { username, password }),
        failure: {
          what: `device ${id} is created, but it has no Ringotel user yet`,
          retry: 'devices.rotate on the device creates it'
        }
      });
      return { device: toDeviceOut(row) };
    }
    return {
      device: toDeviceOut(row),
      sipUsername: username,
      sipPassword: password
    };
  }
});
