import { z } from 'zod';

import { deleteAudioFile, storeAudio } from '$lib/server/audio/types.js';
import { isAcceptedUploadType } from '$lib/server/audio/uploadTypes.js';

import { propagate, recordChange } from '../runner.js';
import { defineOperation } from '../types.js';
import { toAudioAssetOut, type AudioAssetOut } from './_shared.js';

export const uploadSchema = z.object({
  filename: z.string().min(1),
  // §10.2 "Greetings and audio": WAV or MP3 only; any other type is invalid input (422, §10.3).
  mimeType: z
    .string()
    .min(1)
    .refine(isAcceptedUploadType, 'upload: only WAV and MP3 are accepted'),
  data: z.instanceof(Buffer)
});

export const createAudioAssetInput = z
  .object({
    kind: z
      .enum(['greeting', 'moh', 'vmGreeting', 'announcement'])
      .describe(
        "What the asset is for: a menu greeting, hold or ringing music (moh, see zamfono.help music-licensing), a mailbox greeting, or an announcement target's audio."
      ),
    label: z.string().min(1),
    upload: uploadSchema.describe(
      'The file, WAV or MP3, sent as multipart form data; it is transcoded for playback.'
    )
  })
  .strict();

/**
 * `POST /audio` (§10.2 "Greetings and audio"): transcodes and stores the upload through
 * `storeAudio`, then rows it as an `audio_assets` asset under the id it returns.
 */
export const createAudioAsset = defineOperation({
  name: 'audio.create',
  description: 'Uploads and transcodes a new audio asset.',
  input: createAudioAssetInput,
  minRole: 'admin',
  entity: (_input, out: AudioAssetOut) => ({ kind: 'audio', id: out.id }),
  run: async (ctx, input) => {
    const stored = await storeAudio(input.kind, input.upload);
    try {
      await ctx.db
        .insertInto('audioAssets')
        .values({
          id: stored.id,
          label: input.label,
          kind: input.kind,
          filename: stored.filename,
          uploadedBy: ctx.actor.id,
          createdAt: ctx.now
        })
        .execute();
    } catch (error) {
      // The transaction rolls back this row on throw; delete the file it would have orphaned.
      await deleteAudioFile(stored.filename);
      throw error;
    }
    recordChange(ctx, { field: 'label', from: null, to: input.label });
    if (input.kind === 'moh') {
      propagate(ctx, ['moh']);
    }
    const row = await ctx.db
      .selectFrom('audioAssets')
      .selectAll()
      .where('id', '=', stored.id)
      .executeTakeFirstOrThrow();
    return toAudioAssetOut(row);
  }
});
