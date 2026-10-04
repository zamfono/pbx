import { z } from 'zod';

import { HTTP_NOT_FOUND, retireGreeting } from '@zamfono/shared';

import { deleteAudioFile, storeAudio } from '#lib/server/audio/store.js';

import { uploadSchema } from '../audio/create.js';
import { ownUserId } from '../gates.js';
import { propagate } from '../propagate.js';
import { defineOperation } from '../types.js';
import { GREETING_LABEL } from './_greeting.js';
import { liveUser } from './_shared.js';

/**
 * `PUT /users/{id}/voicemailGreeting` (§10.2 "Mailbox access", "Greetings and audio"): the
 * user's personal mailbox greeting, as `*96` records it: the upload, transcoded like any
 * `audio.create` of kind `vmGreeting`, becomes an `audio_assets` row of that kind and the user's
 * `mailbox_audio_id`, replacing the previous one, which is soft-deleted. Outside the audit log like the phone's own
 * recording (§5.7). The propagation makes `core` reload its config, from which a deposit plays
 * the greeting.
 */
export const setVoicemailGreeting = defineOperation({
  name: 'users.setVoicemailGreeting',
  description:
    "Sets a user's personal voicemail greeting from a WAV or MP3 upload, as recording it on *96 does; over MCP, answers with a link to upload the file to.",
  input: z
    .object({
      id: z.string().describe('The user whose mailbox greets with it.'),
      upload: uploadSchema.describe(
        'The greeting, WAV or MP3, sent as multipart form data; it is transcoded for playback.'
      )
    })
    .strict(),
  output: z.object({ id: z.string(), mailboxAudioId: z.string() }),
  problems: [HTTP_NOT_FOUND],
  minRole: 'user',
  scope: ownUserId,
  audit: false,
  run: async (ctx, input) => {
    const user = await liveUser(ctx.db, input.id);
    const stored = await storeAudio('vmGreeting', input.upload);
    try {
      await ctx.db
        .insertInto('audioAssets')
        .values({
          id: stored.id,
          label: GREETING_LABEL,
          kind: 'vmGreeting',
          filename: stored.filename,
          uploadedBy: ctx.actor.id,
          createdAt: ctx.now
        })
        .execute();
      await ctx.db
        .updateTable('users')
        .set({ mailboxAudioId: stored.id })
        .where('id', '=', input.id)
        .execute();
      await retireGreeting(ctx.db, user.mailboxAudioId, ctx.now);
    } catch (error) {
      // The transaction rolls back these rows on throw; delete the file they would have orphaned.
      await deleteAudioFile(stored.filename);
      throw error;
    }
    propagate(ctx, []);
    return { id: input.id, mailboxAudioId: stored.id };
  }
});
