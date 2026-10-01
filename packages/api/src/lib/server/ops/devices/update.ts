import { z } from 'zod';

import { propagate, recordChange } from '../runner.js';
import { defineOperation, OpError } from '../types.js';
import {
  assertDeviceScope,
  liveDevice,
  STATUS_UNPROCESSABLE_ENTITY,
  toDeviceOut
} from './_shared.js';
import { assertNonEmptyIps, assertValidIps } from './_transportPolicy.js';

const inputSchema = z
  .object({
    id: z.string(),
    label: z.string().min(1).optional(),
    allowedIps: z
      .array(z.string())
      .optional()
      .describe(
        'IPs or CIDR ranges, IPv4 or IPv6, the only sources a plain device may register and call from; required for plain, refused for tls.'
      )
  })
  .strict();

/** `PATCH /devices/{id}` (§10.3): label and, for a `plain` device, its IP allowlist. */
export const update = defineOperation({
  name: 'devices.update',
  description:
    "Updates a device's label or, for a plain device, its IP allowlist.",
  input: inputSchema,
  minRole: 'user',
  entity: input => ({ kind: 'device', id: input.id }),
  run: async (ctx, input) => {
    const before = await liveDevice(ctx.db, input.id);
    assertDeviceScope(ctx.actor.role, ctx.actor.id, before);
    if (input.allowedIps !== undefined && before.transport !== 'plain') {
      throw new OpError(
        STATUS_UNPROCESSABLE_ENTITY,
        'devices: allowedIps applies only to a plain device'
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
    if (label !== before.label) {
      recordChange(ctx, { field: 'label', from: before.label, to: label });
    }
    if (allowedIpsJson !== before.allowedIpsJson) {
      recordChange(ctx, {
        field: 'allowedIps',
        from: before.allowedIpsJson
          ? (JSON.parse(before.allowedIpsJson) as string[])
          : null,
        to: input.allowedIps ?? null
      });
      propagate(ctx, ['pjsip']);
    }
    await ctx.db
      .updateTable('devices')
      .set({ label, allowedIpsJson })
      .where('id', '=', input.id)
      .execute();
    return { device: toDeviceOut(await liveDevice(ctx.db, input.id)) };
  }
});
