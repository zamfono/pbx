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

// The owner part is an entity id, a UUID (§11.1).
const MWI_MAILBOX =
  /^(?:user|ringGroup):[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

/** Whether `value` is an MWI name in exactly the shape `mwiMailboxOf` produces. */
export function isMwiMailbox(value: string): value is MwiMailbox {
  return MWI_MAILBOX.test(value);
}

/** The owner an MWI name addresses, the inverse of `mwiMailboxOf`. */
export function parseMwiMailbox(mailbox: MwiMailbox): MailboxOwner {
  const ownerId = mailbox.slice(mailbox.indexOf(':') + 1);
  return mailbox.startsWith('user:')
    ? { userId: ownerId }
    : { ringGroupId: ownerId };
}
