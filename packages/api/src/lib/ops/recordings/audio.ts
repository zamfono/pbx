import { z } from 'zod';

import { defineOperation } from '../types.js';
import { loadRecording, loadRecordingAudio } from './_shared.js';

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
 * WAV or, with `format`, transcoded for download; `admin`/`owner` only.
 */
export const audio = defineOperation({
  name: 'recordings.audio',
  description: "Returns a recording's mixed audio.",
  input: inputSchema,
  minRole: 'admin',
  readOnly: true,
  run: async (ctx, input) => {
    const row = await loadRecording(ctx.db, input.id);
    return loadRecordingAudio(row.filename, input.format);
  }
});
