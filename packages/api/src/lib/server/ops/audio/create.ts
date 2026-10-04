import { z } from 'zod';

import { AUDIO_KINDS } from '@zamfono/shared';

import { deleteAudioFile, storeAudio } from '#lib/server/audio/store.js';
import { isAcceptedUploadType } from '#lib/server/audio/uploadTypes.js';

import { recordChange } from '../audit.js';
import { propagate } from '../propagate.js';
import { defineOperation } from '../types.js';
import {
  audioAssetOut,
  toAudioAssetOut,
  type AudioAssetOut
} from './_shared.js';

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
      .enum(AUDIO_KINDS)
      .describe(
        "What the asset is for: a ring group's greeting (greeting), hold or ringing music (moh, see zamfono.help music-licensing), a mailbox greeting (vmGreeting), or a menu's or announcement target's audio (announcement)."
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
  description:
    'Uploads and transcodes a new audio asset; over MCP, answers with a link to upload the file to.',
  input: createAudioAssetInput,
  output: audioAssetOut,
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
