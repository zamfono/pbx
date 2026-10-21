import { randomBytes } from 'node:crypto';
import * as env from '$app/env/private';
import { z } from 'zod';

import { HTTP_NOT_FOUND, HTTP_UNPROCESSABLE_CONTENT } from '@zamfono/shared';

import { sha256Hex } from '#lib/server/hash.js';

import { recordChange } from '../audit.js';
import { defineOperation, OpError } from '../types.js';
import { liveDevice } from './_shared.js';

// §10.4 "`yealink`": 32 random bytes, as many as a personal access token's.
const TOKEN_BYTES = 32;

/** The path prefix of every provisioning link (§10.4). */
export const PROVISION_PREFIX = '/provision';

export const provisioningLinkOut = z
  .string()
  .describe(
    "The link to enter as the phone's provisioning server URL, shown once; as sensitive as the SIP password."
  );

/** A new provisioning link: its token, the token's SHA-256 the device keeps, and the URL. */
export function newProvisioningLink(): {
  token: string;
  tokenHash: string;
  url: string;
} {
  const token = randomBytes(TOKEN_BYTES).toString('base64url');
  return {
    token,
    tokenHash: sha256Hex(token),
    url: `https://${env.FQDN}${PROVISION_PREFIX}/${token}/`
  };
}

/**
 * `POST /devices/{id}/provisioningLink` (§10.4 "`yealink`"): a new link for a `yealink` device,
 * returned once; the one before stops working at once.
 */
export const provisioningLink = defineOperation({
  name: 'devices.provisioningLink',
  description:
    "Replaces a yealink desk phone's provisioning link, shown once; the old link stops working.",
  input: z.object({ id: z.string() }).strict(),
  output: z.object({ url: provisioningLinkOut }),
  problems: [HTTP_NOT_FOUND],
  minRole: 'admin',
  entity: input => ({ kind: 'device', id: input.id }),
  run: async (ctx, input) => {
    const row = await liveDevice(ctx.db, input.id);
    if (row.kind !== 'yealink') {
      throw new OpError(
        HTTP_UNPROCESSABLE_CONTENT,
        'devices: provisioning links apply only to yealink devices'
      );
    }
    const link = newProvisioningLink();
    await ctx.db
      .updateTable('devices')
      .set({ provisioningTokenHash: link.tokenHash })
      .where('id', '=', input.id)
      .execute();
    recordChange(ctx, { field: 'token', from: null, to: link.token });
    return { url: link.url };
  }
});
