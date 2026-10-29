import { z } from 'zod';

import {
  orderByInput,
  orderOf,
  pageInput,
  pageOutput,
  sqlPage
} from '#lib/server/pagination.js';

import { searchContacts } from '../search/query.js';
import { defineOperation } from '../types.js';
import { contactOut, toContactOut } from './_shared.js';

/** `GET /contacts` (§10.3 "Phone book"): live contacts, alphabetical, paginated. */
export const listContacts = defineOperation({
  name: 'contacts.list',
  description: "Lists the tenant's live phone-book contacts.",
  input: z
    .object({
      // eslint-disable-next-line id-length -- 'q' is the wire query-parameter name, as `GET /search?q=`'s
      q: z
        .string()
        .min(1)
        .optional()
        .describe(
          "Only contacts whose name or company contains this text, case-insensitively, or one of whose numbers contains these digits, as written internationally or in the tenant's country."
        ),
      orderBy: orderByInput(['displayName', 'createdAt'], 'by displayName'),
      ...pageInput.shape
    })
    .strict(),
  output: pageOutput(contactOut),
  minRole: 'user',
  scope: 'any',
  readOnly: true,
  run: async (ctx, input) => {
    let query = ctx.db
      .selectFrom('contacts')
      .selectAll()
      .where('deletedAt', 'is', null);
    if (input.q !== undefined) {
      const hits = await searchContacts(ctx.db, input.q.toLowerCase());
      query = query.where(
        'id',
        'in',
        hits.map(hit => hit.id)
      );
    }
    const { page, nextPageToken, totalSize } = await sqlPage(
      ctx.operation,
      input,
      query,
      orderOf(input.orderBy, [
        ['displayName', 'asc'],
        ['id', 'asc']
      ])
    );
    const items = await Promise.all(page.map(row => toContactOut(ctx.db, row)));
    return { items, nextPageToken, totalSize };
  }
});
