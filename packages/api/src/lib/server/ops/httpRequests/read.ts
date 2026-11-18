import { z } from 'zod';

import { HTTP_NOT_FOUND } from '@zamfono/shared';

import { pageInput, pageOutput, sqlPage } from '#lib/server/pagination.js';

import { defineOperation } from '../types.js';
import {
  httpRequestOut,
  liveHttpRequest,
  toHttpRequestOut
} from './_shared.js';

export const getHttpRequest = defineOperation({
  name: 'httpRequests.get',
  description: 'Reads one live HTTP request of call flows by id.',
  input: z.object({ id: z.string() }).strict(),
  output: httpRequestOut,
  problems: [HTTP_NOT_FOUND],
  minRole: 'admin',
  readOnly: true,
  run: async (ctx, input) =>
    toHttpRequestOut(ctx.db, await liveHttpRequest(ctx.db, input.id))
});

/** `GET /httpRequests` (§10.3 "HTTP requests"): the live ones, alphabetical, paginated. */
export const listHttpRequests = defineOperation({
  name: 'httpRequests.list',
  description: "Lists the tenant's live HTTP requests of call flows.",
  input: pageInput.strict(),
  output: pageOutput(httpRequestOut),
  minRole: 'admin',
  readOnly: true,
  run: async (ctx, input) => {
    const { page, nextPageToken, totalSize } = await sqlPage(
      ctx.operation,
      input,
      ctx.db
        .selectFrom('httpRequests')
        .selectAll()
        .where('deletedAt', 'is', null),
      [
        ['name', 'asc'],
        ['id', 'asc']
      ]
    );
    const items = await Promise.all(
      page.map(row => toHttpRequestOut(ctx.db, row))
    );
    return { items, nextPageToken, totalSize };
  }
});
