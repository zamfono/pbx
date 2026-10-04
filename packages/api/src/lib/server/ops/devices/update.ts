import { z } from 'zod';

import { allowedIpsColumn, HTTP_UNPROCESSABLE_CONTENT } from '@zamfono/shared';

import { recordFieldChanges } from '../audit.js';
import { propagate } from '../propagate.js';
import { defineOperation, OpError } from '../types.js';
import { liveDevice, ownTlsDevice, toDeviceOut } from './_shared.js';
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
    if (input.allowedIps !== undefined) {
      assertNonEmptyIps(input.allowedIps);
      assertValidIps(input.allowedIps);
    }
    const label = input.label ?? before.label;
    const allowedIpsJson =
      input.allowedIps === undefined
        ? before.allowedIpsJson
        : JSON.stringify(input.allowedIps);
    const columns = { label, allowedIpsJson };
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
    return { device: toDeviceOut(await liveDevice(ctx.db, input.id)) };
  }
});
