/**
 * The one rule for a mailbox's MWI name (§3.1, §9.3 "MWI"): `user:<id>` or `ringGroup:<id>`, the
 * name core pushes the counts to Asterisk under and `api` names on `POST /internal/mwi/{mailbox}`.
 */
import type { MwiMailbox } from './internalApi.js';

/** A voicemail mailbox's owner: a user's own mailbox, or a ring group's. */
export type MailboxOwner = { userId: string } | { ringGroupId: string };

/** The MWI name `owner`'s mailbox is addressed as. */
export function mwiMailboxOf(owner: MailboxOwner): MwiMailbox {
  return 'userId' in owner
    ? `user:${owner.userId}`
    : `ringGroup:${owner.ringGroupId}`;
}

/** The owner an MWI name addresses, the inverse of `mwiMailboxOf`. */
export function parseMwiMailbox(mailbox: MwiMailbox): MailboxOwner {
  const ownerId = mailbox.slice(mailbox.indexOf(':') + 1);
  return mailbox.startsWith('user:')
    ? { userId: ownerId }
    : { ringGroupId: ownerId };
}
