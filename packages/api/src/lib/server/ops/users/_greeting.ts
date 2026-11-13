import * as env from '$app/env/private';

import { deletePromptFiles } from '@zamfono/shared';

import { afterCommit } from '../afterCommit.js';
import type { Context } from '../types.js';

/** The label of a personal greeting's `audio_assets` row, the one `*96` gives a recorded one
 * (`core`'s `mailboxGreeting.ts`). */
export const GREETING_LABEL = 'Mailbox greeting';

/** Deletes the files of the greeting whose row `retireGreeting` deleted, `retiredId`, once
 * `ctx`'s transaction has committed (§5.9): a rollback restores the row, not the files. */
export function retireGreetingFiles(
  ctx: Context,
  retiredId: string | null
): void {
  if (retiredId !== null) {
    afterCommit(ctx, async () => {
      await deletePromptFiles(env.MEDIA_DIR, retiredId);
      return null;
    });
  }
}
