import type { Selectable, Transaction } from 'kysely';
import { z } from 'zod';

import { normalizeDialed, type DB } from '@zamfono/shared';

import { OpError } from '../types.js';

const STATUS_UNPROCESSABLE_ENTITY = 422;

/** A `contacts` row as Kysely's `CamelCasePlugin` maps it (§11.2). */
export type ContactRow = Selectable<DB['contacts']>;

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

export type ContactPhoneOut = { label: string; number: string };
export type ContactOut = {
  id: string;
  displayName: string;
  company: string | null;
  email: string | null;
  phones: ContactPhoneOut[];
};

/**
 * Normalizes a phone-book number to E.164 (§10.2 "Phone book", §9.4): strips everything but an
 * optional leading `+` and digits, then applies the outbound resolution rules of `settings.country`.
 */
export function normalizeContactPhone(raw: string, country: string): string {
  const cleaned = raw.startsWith('+')
    ? `+${raw.slice(1).replace(/\D/gu, '')}`
    : raw.replace(/\D/gu, '');
  const normalized = normalizeDialed(cleaned, country);
  if (normalized.kind === 'incomplete') {
    throw new OpError(
      STATUS_UNPROCESSABLE_ENTITY,
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
        STATUS_UNPROCESSABLE_ENTITY,
        `contacts: duplicate phone number '${phone.number}'`
      );
    }
    numbers.add(phone.number);
    if (labels.has(phone.label)) {
      throw new OpError(
        STATUS_UNPROCESSABLE_ENTITY,
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
  country: string
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
export async function tenantCountry(db: Transaction<DB>): Promise<string> {
  const settings = await db
    .selectFrom('settings')
    .select('country')
    .executeTakeFirstOrThrow();
  return settings.country;
}
