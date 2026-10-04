import path from 'node:path';
import * as env from '$app/env/private';
import { z } from 'zod';

import { HTTP_NOT_FOUND, VOICEMAIL_SUBDIR } from '@zamfono/shared';

import {
  downloadAudio,
  downloadAudioOutput
} from '#lib/server/audio/transcode.js';

import { defineOperation } from '../types.js';
import { loadVoicemail, ownVoicemail } from './_shared.js';

const inputSchema = z
  .object({
    id: z.string(),
    format: z
      .enum(['opus', 'mp3'])
      .optional()
      .describe(
        'A compressed transcode for download; left out, the stored WAV.'
      )
  })
  .strict();

/**
 * `GET /voicemails/{id}/audio` (§10.3, §11.6): the voicemail's recorded audio, as the stored WAV
 * or, with `format`, transcoded for download; over MCP, a link to this endpoint (§10.5).
 */
export const audio = defineOperation({
  name: 'voicemails.audio',
  description:
    "Returns a voicemail's recorded audio; over MCP, a download link that opens for five minutes.",
  input: inputSchema,
  output: downloadAudioOutput,
  problems: [HTTP_NOT_FOUND],
  minRole: 'user',
  scope: ownVoicemail,
  readOnly: true,
  run: async (ctx, input) => {
    const row = await loadVoicemail(ctx, input.id);
    return downloadAudio(
      path.join(env.MEDIA_DIR, VOICEMAIL_SUBDIR, row.filename),
      input.format
    );
  }
});
