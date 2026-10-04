import type { Selectable, Transaction } from 'kysely';
import { z } from 'zod';

import {
  HTTP_UNPROCESSABLE_CONTENT,
  normalizeDialed,
  type CountryCode,
  type DB
} from '@zamfono/shared';

import { liveRow } from '../rows.js';
import { OpError } from '../types.js';

/** A `contacts` row as Kysely's `CamelCasePlugin` maps it (§11.2). */

export type ContactRow = Selectable<DB['contacts']>;

/** Loads a live contact by id, or throws `OpError(404)`. */
export async function liveContact(
  db: Transaction<DB>,
  id: string
): Promise<ContactRow> {
  return liveRow(db, 'contacts', id, `contact '${id}' not found`);
}

export const phoneSchema = z.object({
  label: z
    .string()
    .min(1)
    .describe(
      "The number's label, such as 'Mobile'; unique within the contact."
    ),
  number: z
    .string()
    .min(1)
    .describe(
      'The number, E.164 or national, normalized to E.164 with settings.country; incoming calls from it show the contact name.'
    )
});
export type PhoneInput = z.infer<typeof phoneSchema>;

/** The fields `contacts.create` takes and `contacts.update` takes each optionally (§10.3). */
export const contactFields = {
  displayName: z.string().min(1),
  company: z.string().nullish(),
  email: z.email().nullish(),
  phones: z
    .array(phoneSchema)
    .optional()
    .describe('The contact numbers; on update, the set is replaced as a whole.')
};

const contactPhoneOut = z.object({
  label: z.string(),
  number: z.string().describe('The number, E.164.')
});
export type ContactPhoneOut = z.infer<typeof contactPhoneOut>;

/** A contact's wire shape (§10.3), as `toContactOut` assembles it. */
export const contactOut = z.object({
  id: z.string(),
  displayName: z.string(),
  company: z.string().nullable(),
  email: z.string().nullable(),
  phones: z.array(contactPhoneOut)
});
export type ContactOut = z.infer<typeof contactOut>;

/** `raw` with everything but an optional leading `+` and digits stripped. */
export function phoneDigits(raw: string): string {
  return raw.startsWith('+')
    ? `+${raw.slice(1).replace(/\D/gu, '')}`
    : raw.replace(/\D/gu, '');
}

/**
 * A phone-book number in E.164 (§10.2 "Phone book", §9.4): `raw`'s `phoneDigits` under the
 * outbound resolution rules of `settings.country`, refused with 422 when those leave it
 * incomplete.
 */
export function normalizeContactPhone(
  raw: string,
  country: CountryCode
): string {
  const normalized = normalizeDialed(phoneDigits(raw), country);
  if (normalized.kind === 'incomplete') {
    throw new OpError(
      HTTP_UNPROCESSABLE_CONTENT,
      `contacts: '${raw}' is not a resolvable phone number`
    );
  }
  return normalized.number;
}

/** Throws 422 when `phones` holds two entries with the same normalized number or the same label (`contact_phones`' PRIMARY KEY and UNIQUE, §11.2). */
function assertPhonesUnique(phones: { number: string; label: string }[]): void {
  const numbers = new Set<string>();
  const labels = new Set<string>();
  for (const phone of phones) {
    if (numbers.has(phone.number)) {
      throw new OpError(
        HTTP_UNPROCESSABLE_CONTENT,
        `contacts: duplicate phone number '${phone.number}'`
      );
    }
    numbers.add(phone.number);
    if (labels.has(phone.label)) {
      throw new OpError(
        HTTP_UNPROCESSABLE_CONTENT,
        `contacts: duplicate phone label '${phone.label}'`
      );
    }
    labels.add(phone.label);
  }
}

/** Replaces a contact's phone-number set as a whole, normalizing every number on write. */
export async function replacePhones(
  db: Transaction<DB>,
  contactId: string,
  phones: PhoneInput[],
  country: CountryCode
): Promise<void> {
  const normalized = phones.map(phone => ({
    contactId,
    number: normalizeContactPhone(phone.number, country),
    label: phone.label
  }));
  assertPhonesUnique(normalized);
  await db
    .deleteFrom('contactPhones')
    .where('contactId', '=', contactId)
    .execute();
  if (normalized.length === 0) {
    return;
  }
  await db.insertInto('contactPhones').values(normalized).execute();
}

export async function contactPhones(
  db: Transaction<DB>,
  contactId: string
): Promise<ContactPhoneOut[]> {
  const rows = await db
    .selectFrom('contactPhones')
    .select(['label', 'number'])
    .where('contactId', '=', contactId)
    .orderBy('label')
    .execute();
  return rows;
}

/** Assembles the wire shape of a contact from its row and phone-number list (§10.3). */
export async function toContactOut(
  db: Transaction<DB>,
  row: ContactRow
): Promise<ContactOut> {
  return {
    id: row.id,
    displayName: row.displayName,
    company: row.company,
    email: row.email,
    phones: await contactPhones(db, row.id)
  };
}

/** The tenant's calling-code country (§9.4), used to normalize a contact's numbers on write. */
export async function tenantCountry(db: Transaction<DB>): Promise<CountryCode> {
  const settings = await db
    .selectFrom('settings')
    .select('country')
    .executeTakeFirstOrThrow();
  return settings.country;
}
