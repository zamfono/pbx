import { assertSelfOrAdmin } from '../gates.js';
import type { Context } from '../types.js';

/** The label of a personal greeting's `audio_assets` row, the one `*96` gives a recorded one
 * (`core`'s `mailboxGreeting.ts`). */
export const GREETING_LABEL = 'Mailbox greeting';

/** Throws 403 for a `user` naming another user's mailbox greeting: self-service on one's own id
 * alone, an admin's for any user (§10.3 "Users"). */
export function assertOwnGreeting(ctx: Context, userId: string): void {
  assertSelfOrAdmin(
    ctx.actor,
    userId,
    'users: may set only your own voicemail greeting'
  );
}
