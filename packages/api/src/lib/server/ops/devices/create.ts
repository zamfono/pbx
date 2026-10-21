import * as env from '$app/env/private';
import { z } from 'zod';

import {
  DEVICE_KINDS,
  DEVICE_TRANSPORTS,
  HTTP_CONFLICT,
  HTTP_NOT_FOUND,
  HTTP_UNPROCESSABLE_CONTENT,
  newId,
  type DeviceKind
} from '@zamfono/shared';

import { storedCredentials } from '#lib/server/provisioning/ringotelUser.js';
import { encrypt, keyringFromEnv } from '#lib/server/secretbox.js';
import { newSipPassword } from '#lib/server/sip.js';

import { recordChange } from '../audit.js';
import { ownActingUser } from '../gates.js';
import { propagate } from '../propagate.js';
import { defineOperation, OpError, type Context } from '../types.js';
import { requireUserExtension } from '../users/_extensions.js';
import { liveUser } from '../users/_shared.js';
import {
  connectionSettings,
  connectionSettingsOut
} from './_connectionSettings.js';
import { keyColumns, YEALINK_DEFAULT_KEYS } from './_keys.js';
import {
  mwiRingGroupsSchema,
  writeMwiRingGroups,
  type MwiRingGroups
} from './_mwiRingGroups.js';
import { pushToRingotel } from './_ringotelPush.js';
import {
  assertNoExistingRingotelDevice,
  deviceOut,
  deviceOutOf,
  liveDevice
} from './_shared.js';
import { uniqueSipUsername } from './_sipUsername.js';
import {
  assertKindTransport,
  assertNonEmptyIps,
  assertPlainTransportEnabled,
  assertValidIps
} from './_transportPolicy.js';
import {
  newProvisioningLink,
  provisioningLinkOut
} from './provisioningLink.js';

/** A new `yealink` device's key list (§10.4 "`yealink`"). */
async function insertYealinkKeys(
  ctx: Context,
  deviceId: string
): Promise<void> {
  await ctx.db
    .insertInto('deviceBlfKeys')
    .values(
      YEALINK_DEFAULT_KEYS.map((key, position) => ({
        deviceId,
        position,
        ...keyColumns(key)
      }))
    )
    .execute();
}

/**
 * A new device's message-indicator ring groups (§9.3 "MWI"), `[]` for a `yealink` one and every
 * group for any other unless given, and a new `yealink` device's key list (§10.4 "`yealink`").
 */
async function writeDefaults(
  ctx: Context,
  id: string,
  input: {
    userId: string;
    kind: DeviceKind;
    mwiRingGroups?: MwiRingGroups | undefined;
  }
): Promise<void> {
  const yealink = input.kind === 'yealink';
  await writeMwiRingGroups(
    ctx,
    { id, userId: input.userId },
    input.mwiRingGroups ?? (yealink ? [] : null)
  );
  if (yealink) {
    await insertYealinkKeys(ctx, id);
  }
}

const inputSchema = z
  .object({
    userId: z.string(),
    label: z.string().min(1),
    kind: z
      .enum(DEVICE_KINDS)
      .describe(
        "manual: a softphone or desk phone set up by hand from the returned connection settings; ringotel: the user's Ringotel app account, at most one per user (see zamfono.help ringotel-setup); yealink: a Yealink desk phone that fetches its configuration from the returned provisioning link (see zamfono.help yealink-desk-phones)."
      ),
    transport: z
      .enum(DEVICE_TRANSPORTS)
      .optional()
      .describe(
        'tls (the default): SIP over TLS from anywhere; plain: UDP or TCP from allowedIps only, manual devices alone (see zamfono.help remote-workers).'
      ),
    allowedIps: z
      .array(z.string())
      .optional()
      .describe(
        'IPs or CIDR ranges, IPv4 or IPv6, the only sources a plain device may register and call from; required for plain, refused for tls.'
      ),
    mwiRingGroups: mwiRingGroupsSchema
      .optional()
      .describe(
        "The ring groups whose mailboxes the message indicator counts besides the user's own: null for every group the user belongs to, [] for the own mailbox alone. Default: [] for yealink, whose group mailboxes go on mailbox keys, else null."
      )
  })
  .strict();
/**
 * A `manual` device's response carries its connection settings (§10.4 "`manual`"), a `yealink`
 * device's its provisioning link as well (§10.4 "`yealink`"); a `ringotel` device's credentials
 * are pushed to Ringotel, so its response carries only the device, and an admin reveals them
 * later through `devices.revealCredentials` (§5.2).
 */
const outputSchema = z.object({
  device: deviceOut,
  connectionSettings: connectionSettingsOut.optional(),
  provisioningLink: provisioningLinkOut.optional()
});
type Output = z.infer<typeof outputSchema>;

/** `POST /users/{id}/devices` (§10.3, §9.3): creates a SIP device, returning a manual one's connection settings once. */
export const create = defineOperation({
  name: 'devices.create',
  description:
    "Creates a SIP device for a user; a manual or yealink device's connection settings, and a yealink device's provisioning link, are returned once.",
  input: inputSchema,
  output: outputSchema,
  problems: [HTTP_NOT_FOUND, HTTP_CONFLICT],
  minRole: 'user',
  scope: (ctx, input) =>
    ownActingUser(ctx, input) && (input.transport ?? 'tls') === 'tls',
  entity: (_input, out: Output) => ({ kind: 'device', id: out.device.id }),
  run: async (ctx, input) => {
    const transport = input.transport ?? 'tls';
    const ext = await requireUserExtension(
      ctx.db,
      await liveUser(ctx.db, input.userId),
      'devices'
    );
    assertKindTransport(input.kind, transport);
    if (transport === 'plain') {
      assertPlainTransportEnabled();
      assertNonEmptyIps(input.allowedIps ?? []);
      assertValidIps(input.allowedIps ?? []);
    } else if (input.allowedIps !== undefined) {
      throw new OpError(
        HTTP_UNPROCESSABLE_CONTENT,
        'devices: allowedIps applies only to a plain device'
      );
    }
    if (input.kind === 'ringotel') {
      await assertNoExistingRingotelDevice(ctx.db, input.userId);
    }
    const username = await uniqueSipUsername(ctx.db, ext);
    const password = newSipPassword();
    const id = newId();
    const kr = keyringFromEnv(env);
    const link = input.kind === 'yealink' ? newProvisioningLink() : null;
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
        sipPasswordEnc: encrypt(kr, 'devices.sipPasswordEnc', password),
        ...(link !== null && {
          provisioningTokenHash: link.tokenHash,
          adminPasswordEnc: encrypt(
            kr,
            'devices.adminPasswordEnc',
            newSipPassword()
          )
        }),
        createdAt: ctx.now
      })
      .execute();
    await writeDefaults(ctx, id, input);
    // No `sipPassword` diff entry: masking it would mark the whole creation non-undoable
    // (§5.8), and unlike `devices.rotate` a creation has no prior state to lose by reverting.
    recordChange(ctx, { field: 'label', from: null, to: input.label });
    propagate(ctx, ['pjsip']);
    const row = await liveDevice(ctx.db, id);
    const device = await deviceOutOf(ctx.db, row);
    if (input.kind === 'ringotel') {
      pushToRingotel(ctx, {
        trigger: 'devices.create',
        deviceId: id,
        push: (provider, stored) =>
          provider.onDeviceCreated(stored, storedCredentials(stored)),
        failure: {
          what: `device ${id} is created, but it has no Ringotel user yet`,
          retry: 'devices.rotate on the device creates it'
        }
      });
      return { device };
    }
    return {
      device,
      connectionSettings: await connectionSettings(ctx.db, row, password),
      ...(link !== null && { provisioningLink: link.url })
    };
  }
});
