import { z } from 'zod';

import { HTTP_NOT_FOUND } from '@zamfono/shared';

import { propagate } from '../propagate.js';
import { idOutput, liveRow, softDelete, softDeleteQuestion } from '../rows.js';
import { renderSipBanListAfterCommit } from '../sipBans/_shared.js';
import { defineOperation } from '../types.js';

const inputSchema = z.object({ id: z.string() }).strict();

/** `DELETE /sipAllowlist/{id}` (§5.6, §10.3 "SIP bans"): soft-deletes an allowlist entry. */
export const del = defineOperation({
  name: 'sipAllowlist.delete',
  description: 'Removes a source from the SIP ban allowlist',
  input: inputSchema,
  output: idOutput,
  problems: [HTTP_NOT_FOUND],
  minRole: 'admin',
  confirm: async (ctx, input) => {
    const row = await liveRow(
      ctx.db,
      'sipAllowlist',
      input.id,
      `SIP allowlist entry '${input.id}' not found`
    );
    return softDeleteQuestion(ctx, `the SIP allowlist entry ${row.address}`);
  },
  entity: input => ({ kind: 'sipAllowlistEntry', id: input.id }),
  run: async (ctx, input) => {
    await liveRow(ctx.db, 'sipAllowlist', input.id, 'sipAllowlist: not found');
    await softDelete(ctx, 'sipAllowlist', input.id);
    // `core` reads the allowlist for its exemptions (§5.6), and nothing in it reaches Asterisk's
    // own configuration, so this drops `core`'s config cache without a reload.
    propagate(ctx, []);
    renderSipBanListAfterCommit(ctx);
    return { id: input.id };
  }
});
