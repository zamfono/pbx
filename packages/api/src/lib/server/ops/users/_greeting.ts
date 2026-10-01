import { OpError, type Context } from '../types.js';

const STATUS_FORBIDDEN = 403;

/** The label of a personal greeting's `audio_assets` row, the one `*96` gives a recorded one
 * (`core`'s `mailboxGreeting.ts`). */
export const GREETING_LABEL = 'Mailbox greeting';

/** Throws 403 for a `user` naming another user's mailbox greeting: self-service on one's own id
 * alone, an admin's for any user (§10.3 "Users"). */
export function assertOwnGreeting(ctx: Context, userId: string): void {
  if (ctx.actor.role === 'user' && ctx.actor.id !== userId) {
    throw new OpError(
      STATUS_FORBIDDEN,
      'users: may set only your own voicemail greeting'
    );
  }
}
