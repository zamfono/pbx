import { isIP } from 'node:net';
import { z } from 'zod';

import { HTTP_CONFLICT, isCidr, newId } from '@zamfono/shared';

import { recordChange } from '../audit.js';
import { assertNoLiveHolder } from '../liveHolder.js';
import { propagate } from '../propagate.js';
import { renderSipBanListAfterCommit } from '../sipBans/_shared.js';
import { defineOperation } from '../types.js';
import { liftCoveredBans, sipAllowlistEntryWire } from './_shared.js';

const inputSchema = z
  .object({
    address: z
      .string()
      .refine(
        value => isIP(value) !== 0 || isCidr(value),
        'address must be an IP address or a CIDR range'
      )
      .describe(
        'The source to exempt: an IP address or a CIDR range, IPv4 or IPv6, such as 198.51.100.0/24.'
      ),
    label: z.string().nullable().optional()
  })
  .strict();

/** `POST /sipAllowlist` (§5.6, §10.3 "SIP bans"): a source never banned for failed SIP attempts. */
export const create = defineOperation({
  name: 'sipAllowlist.create',
  description:
    'Exempts a source address or range from SIP bans, ending every active ban it covers',
  input: inputSchema,
  output: sipAllowlistEntryWire,
  problems: [HTTP_CONFLICT],
  minRole: 'admin',
  entity: (_input, output) => ({ kind: 'sipAllowlistEntry', id: output.id }),
  run: async (ctx, input) => {
    await assertNoLiveHolder(ctx.db, 'sipAllowlist: already listed', {
      table: 'sipAllowlist',
      kind: 'sipAllowlistEntry',
      label: 'address',
      values: { address: input.address }
    });
    const id = newId();
    const label = input.label ?? null;
    await ctx.db
      .insertInto('sipAllowlist')
      .values({
        id,
        address: input.address,
        label,
        createdBy: ctx.actor.id,
        createdAt: ctx.now
      })
      .execute();
    recordChange(ctx, { field: 'address', from: null, to: input.address });
    await liftCoveredBans(ctx, input.address);
    // `core` reads the allowlist for its exemptions (§5.6), and nothing in it reaches Asterisk's
    // own configuration, so this drops `core`'s config cache without a reload.
    propagate(ctx, []);
    renderSipBanListAfterCommit(ctx);
    return { id, address: input.address, label, createdAt: ctx.now };
  }
});
