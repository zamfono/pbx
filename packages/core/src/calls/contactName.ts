/**
 * The phone book's caller-name lookup (§10.2 "Phone book"): one indexed equality on
 * `contact_phones.number` against the caller as the pipeline sees it, which the contacts
 * operation stores in the same international form (§9.4). It names the caller in the voicemail
 * and missed-call mails, and it is the caller-ID name on the legs pushed to the softphones.
 */
import { ANONYMOUS, type Db } from '@zamfono/shared';

import type { Call } from './call.js';
import type { Pipeline } from './pipeline.js';

/** The live contact's display name for `from`, empty when none matches or the caller withheld
 * their number, so a mail template's `{{#if callerName}}` picks the wording. */
export async function contactName(db: Db, from: string): Promise<string> {
  if (from === ANONYMOUS) {
    return '';
  }
  const contact = await db
    .selectFrom('contactPhones')
    .innerJoin('contacts', 'contacts.id', 'contactPhones.contactId')
    .select('contacts.displayName')
    .where('contactPhones.number', '=', from)
    .where('contacts.deletedAt', 'is', null)
    .executeTakeFirst();
  return contact?.displayName ?? '';
}

/** `number` as an originate `callerId`: `"<name>" <number>` with the contact's name, the bare
 * number without one. A `"` or `\` would end the quoted name early, so it is dropped. */
export function formatCallerId(number: string, name: string): string {
  const safeName = name.replaceAll(/["\\]/gu, '').trim();
  return safeName === '' ? number : `"${safeName}" <${number}>`;
}

// One lookup per call: a ring group rings its members batch by batch, a user's devices one by one.
const callerIdByCall = new WeakMap<Call, Promise<string>>();

/** The caller ID a leg pushed to a softphone presents for `call` (§10.2 "Phone book"): the
 * caller's number with the phone book's name for it, looked up once per call. */
export function softphoneCallerId(
  pipeline: Pipeline,
  call: Call
): Promise<string> {
  const cached = callerIdByCall.get(call);
  if (cached !== undefined) {
    return cached;
  }
  const { db } = pipeline.deps;
  const lookup =
    db === undefined
      ? Promise.resolve(call.from)
      : contactName(db, call.from)
          .then(name => formatCallerId(call.from, name))
          .catch(() => call.from);
  callerIdByCall.set(call, lookup);
  return lookup;
}
