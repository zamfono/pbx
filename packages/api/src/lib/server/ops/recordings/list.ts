import { z } from 'zod';

import {
  orderByInput,
  orderOf,
  pageInput,
  pageOutput,
  sqlPage
} from '#lib/server/pagination.js';

import { instantInput, tenantInstantReader } from '../instantInput.js';
import { defineOperation } from '../types.js';
import { recordingOut, toRecordingOut } from './_shared.js';

const inputSchema = z
  .object({
    callId: z.string().optional().describe("Only this call's recordings."),
    userId: z
      .string()
      .optional()
      .describe("Only the recordings of this user's side of their calls."),
    from: instantInput
      .optional()
      .describe(
        "Only recordings made at or after this ISO 8601 time, any offset (none: the tenant's time zone)."
      ),
    to: instantInput
      .optional()
      .describe(
        "Only recordings made before this ISO 8601 time, any offset (none: the tenant's time zone), or before the end of this date."
      ),
    orderBy: orderByInput(['createdAt', 'durationS'], 'newest first'),
    ...pageInput.shape
  })
  .strict();

/** `GET /recordings` (§5.3): every call recording, newest first; `admin`/`owner` only. */
export const list = defineOperation({
  name: 'recordings.list',
  description:
    'Lists call recordings, newest first: one per recorded user and call (see zamfono.help recording-consent).',
  input: inputSchema,
  output: pageOutput(recordingOut),
  minRole: 'admin',
  readOnly: true,
  run: async (ctx, input) => {
    let query = ctx.db.selectFrom('recordings').selectAll();
    if (input.callId !== undefined) {
      query = query.where('callId', '=', input.callId);
    }
    if (input.userId !== undefined) {
      query = query.where('userId', '=', input.userId);
    }
    if (input.from !== undefined || input.to !== undefined) {
      const instants = await tenantInstantReader(ctx.db);
      if (input.from !== undefined) {
        query = query.where('createdAt', '>=', instants.start(input.from));
      }
      if (input.to !== undefined) {
        query = query.where('createdAt', '<', instants.end(input.to));
      }
    }
    const { page, nextPageToken, totalSize } = await sqlPage(
      ctx.operation,
      input,
      query,
      orderOf(input.orderBy, [['id', 'desc']])
    );
    return {
      items: page.map(toRecordingOut),
      nextPageToken,
      totalSize
    };
  }
});
