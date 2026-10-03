import {
  decodeIdCursor,
  keysetPage,
  pageInput
} from '#lib/server/pagination.js';

import { defineOperation } from '../types.js';
import { toRecordingOut } from './_shared.js';

const inputSchema = pageInput.strict();

/** `GET /recordings` (§5.3): every call recording, newest first; `admin`/`owner` only. */
export const list = defineOperation({
  name: 'recordings.list',
  description:
    'Lists call recordings, newest first: one per recorded user and call (see zamfono.help recording-consent).',
  input: inputSchema,
  minRole: 'admin',
  readOnly: true,
  run: async (ctx, input) => {
    const { limit } = input;
    const cursor =
      input.cursor === undefined ? undefined : decodeIdCursor(input.cursor);
    let query = ctx.db.selectFrom('recordings').selectAll();
    if (cursor !== undefined) {
      query = query.where('id', '<', cursor);
    }
    const rows = await query
      .orderBy('id', 'desc')
      .limit(limit + 1)
      .execute();
    const { page, nextCursor } = keysetPage(rows, limit);
    return {
      items: page.map(toRecordingOut),
      nextCursor
    };
  }
});
