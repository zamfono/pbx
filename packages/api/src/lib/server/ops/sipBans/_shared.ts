import { z } from 'zod';

import { SIP_BAN_PROTOCOLS } from '@zamfono/shared';

import { renderSipBanList } from '#lib/server/sipBanList.js';

import { afterCommit } from '../afterCommit.js';
import type { Context } from '../types.js';

/** A SIP ban's wire shape (§10.3 "SIP bans"). */
export const sipBanWire = z.object({
  id: z.string(),
  address: z.string(),
  protocol: z
    .enum(SIP_BAN_PROTOCOLS)
    .describe(
      'The transport class the ban drops: udp, or tcp for TCP and TLS.'
    ),
  step: z.number(),
  failures: z.number(),
  createdAt: z.string(),
  expiresAt: z.string().nullable(),
  liftedAt: z.string().nullable(),
  liftedBy: z.string().nullable()
});

/** Renders the ban list once `ctx`'s write to `sip_bans` or `sip_allowlist` has committed (§9.1). */
export function renderSipBanListAfterCommit(ctx: Context): void {
  afterCommit(ctx, async db => {
    await renderSipBanList(db);
    return null;
  });
}
