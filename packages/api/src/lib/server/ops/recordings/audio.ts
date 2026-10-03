import path from 'node:path';
import { z } from 'zod';

import { downloadAudio } from '#lib/server/audio/transcode.js';
import { mediaDirFromEnv } from '#lib/server/mediaDir.js';

import { defineOperation } from '../types.js';
import { loadRecording, RECORDINGS_SUBDIR } from './_shared.js';

const inputSchema = z
  .object({
    id: z.string(),
    format: z
      .enum(['opus', 'mp3'])
      .optional()
      .describe(
        'A compressed transcode for download; left out, the stored stereo WAV.'
      )
  })
  .strict();

/**
 * `GET /recordings/{id}/audio` (§5.3, §11.6): a recording's mixed stereo audio, as the stored
 * WAV or, with `format`, transcoded for download, over MCP a link to this endpoint (§10.5);
 * `admin`/`owner` only.
 */
export const audio = defineOperation({
  name: 'recordings.audio',
  description:
    "Returns a recording's mixed audio; over MCP, a download link that opens for five minutes.",
  input: inputSchema,
  minRole: 'admin',
  readOnly: true,
  run: async (ctx, input) => {
    const row = await loadRecording(ctx.db, input.id);
    return downloadAudio(
      path.join(mediaDirFromEnv(), RECORDINGS_SUBDIR, row.filename),
      input.format
    );
  }
});
