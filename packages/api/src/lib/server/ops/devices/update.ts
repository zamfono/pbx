import { z } from 'zod';

import {
  allowedIpsColumn,
  HTTP_NOT_FOUND,
  HTTP_UNPROCESSABLE_CONTENT
} from '@zamfono/shared';

import { YEALINK_RINGTONES } from '#lib/server/provisioning/yealink.js';

import { recordChange, recordFieldChanges } from '../audit.js';
import { propagate } from '../propagate.js';
import { defineOperation, OpError, type Context } from '../types.js';
import {
  loadMwiRingGroups,
  mwiRingGroupsSchema,
  writeMwiRingGroups,
  type MwiRingGroups
} from './_mwiRingGroups.js';
import { deviceOut, deviceOutOf, liveDevice, ownTlsDevice } from './_shared.js';
import { assertNonEmptyIps, assertValidIps } from './_transportPolicy.js';

/**
 * `PATCH /devices/{id}`'s `mwiRingGroups` (§10.3): stores `groups` when they differ from the
 * device's, records the change for undo, which replays `from` through the same field, and
 * re-renders the device's AOR, whose `mailboxes` they are (§9.3 "MWI").
 */
export async function updateMwiRingGroups(
  ctx: Context,
  device: { id: string; userId: string; mwiAllRingGroups: number },
  groups: MwiRingGroups
): Promise<void> {
  const before = (await loadMwiRingGroups(ctx.db, [device])).get(device.id);
  const after = groups === null ? null : [...new Set(groups)].sort();
  if (JSON.stringify(before) === JSON.stringify(after)) {
    return;
  }
  await writeMwiRingGroups(ctx, device, after);
  recordChange(ctx, { field: 'mwiRingGroups', from: before, to: after });
  propagate(ctx, ['pjsip']);
}

const inputSchema = z
  .object({
    id: z.string(),
    label: z.string().min(1).optional(),
    allowedIps: z
      .array(z.string())
      .optional()
      .describe(
        'IPs or CIDR ranges, IPv4 or IPv6, the only sources a plain device may register and call from; required for plain, refused for tls.'
      ),
    ringtone: z
      .enum(YEALINK_RINGTONES)
      .nullable()
      .optional()
      .describe(
        "A yealink device's built-in ringtone, written into its provisioning link's file; null: the phone's own."
      ),
    mwiRingGroups: mwiRingGroupsSchema.optional()
  })
  .strict();

/**
 * `PATCH /devices/{id}` (§10.3): label, a `plain` device's IP allowlist, a `yealink` device's
 * ringtone, the ring groups its message indicator counts.
 */
export const update = defineOperation({
  name: 'devices.update',
  description:
    "Updates a device's label, a plain device's IP allowlist, a yealink device's ringtone or the ring groups its message indicator counts.",
  input: inputSchema,
  output: z.object({ device: deviceOut }),
  problems: [HTTP_NOT_FOUND],
  minRole: 'user',
  scope: ownTlsDevice,
  entity: input => ({ kind: 'device', id: input.id }),
  run: async (ctx, input) => {
    const before = await liveDevice(ctx.db, input.id);
    if (input.allowedIps !== undefined && before.transport !== 'plain') {
      throw new OpError(
        HTTP_UNPROCESSABLE_CONTENT,
        'devices: allowedIps applies only to a plain device'
      );
    }
    if (input.ringtone !== undefined && before.kind !== 'yealink') {
      throw new OpError(
        HTTP_UNPROCESSABLE_CONTENT,
        'devices: ringtone applies only to a yealink device'
      );
    }
    if (input.allowedIps !== undefined) {
      assertNonEmptyIps(input.allowedIps);
      assertValidIps(input.allowedIps);
    }
    const label = input.label ?? before.label;
    const allowedIpsJson =
      input.allowedIps === undefined
        ? before.allowedIpsJson
        : JSON.stringify(input.allowedIps);
    const ringtone =
      input.ringtone === undefined ? before.ringtone : input.ringtone;
    const columns = { label, allowedIpsJson, ringtone };
    const changed = recordFieldChanges(ctx, before, columns, {
      allowedIpsJson: {
        field: 'allowedIps',
        decode: stored => allowedIpsColumn.nullable().decode(stored)
      }
    });
    if ('allowedIpsJson' in changed) {
      propagate(ctx, ['pjsip']);
    }
    await ctx.db
      .updateTable('devices')
      .set(columns)
      .where('id', '=', input.id)
      .execute();
    if (input.mwiRingGroups !== undefined) {
      await updateMwiRingGroups(ctx, before, input.mwiRingGroups);
    }
    return {
      device: await deviceOutOf(ctx.db, await liveDevice(ctx.db, input.id))
    };
  }
});
