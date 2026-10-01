import { z } from 'zod';

import { defineOperation } from '../types.js';
import {
  assertVoicemailScope,
  loadVoicemail,
  loadVoicemailAudio,
  ringGroupIdsForUser
} from './_shared.js';

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
 * or, with `format`, transcoded for download.
 */
export const audio = defineOperation({
  name: 'voicemails.audio',
  description: "Returns a voicemail's recorded audio.",
  input: inputSchema,
  minRole: 'user',
  readOnly: true,
  run: async (ctx, input) => {
    const row = await loadVoicemail(ctx.db, input.id);
    const ringGroupIds =
      ctx.actor.role === 'user'
        ? await ringGroupIdsForUser(ctx.db, ctx.actor.id)
        : [];
    assertVoicemailScope(ctx.actor.role, ctx.actor.id, row, ringGroupIds);
    return loadVoicemailAudio(row.filename, input.format);
  }
});
