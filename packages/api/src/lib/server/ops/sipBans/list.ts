import { z } from 'zod';

import {
  decodeIdCursor,
  keysetPage,
  pageInput,
  pageOutput
} from '#lib/server/pagination.js';
import { activeSipBans } from '#lib/server/sipBanList.js';

import { defineOperation } from '../types.js';
import { sipBanWire } from './_shared.js';

const inputSchema = pageInput
  .extend({
    state: z
      .enum(['active', 'ended', 'all'])
      .optional()
      .describe(
        'active: bans in force (the default); ended: bans that ran out or were lifted; all: both.'
      )
  })
  .strict();

/** `GET /sipBans` (§5.6, §10.3 "SIP bans"): the bans of sources of failed SIP attempts. */
export const list = defineOperation({
  name: 'sipBans.list',
  description:
    'Lists the bans of sources of failed SIP attempts, the active ones unless state says otherwise',
  input: inputSchema,
  output: pageOutput(sipBanWire),
  minRole: 'admin',
  readOnly: true,
  run: async (ctx, input) => {
    const { limit } = input;
    const state = input.state ?? 'active';
    let query = ctx.db.selectFrom('sipBans').selectAll();
    if (state !== 'all') {
      const active = activeSipBans(ctx.db, ctx.now).select('id');
      query = query.where('id', state === 'active' ? 'in' : 'not in', active);
    }
    if (input.cursor !== undefined) {
      query = query.where(
        'id',
        '>',
        decodeIdCursor(ctx.operation, input.cursor)
      );
    }
    const rows = await query
      .orderBy('id')
      .limit(limit + 1)
      .execute();
    const { page, nextCursor } = keysetPage(ctx.operation, rows, limit);
    return {
      items: page.map(row => ({
        id: row.id,
        address: row.address,
        step: row.step,
        failures: row.failures,
        createdAt: row.createdAt,
        expiresAt: row.expiresAt,
        liftedAt: row.liftedAt,
        liftedBy: row.liftedBy
      })),
      nextCursor
    };
  }
});
