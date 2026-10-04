import type { Transaction } from 'kysely';
import { z } from 'zod';

import type { DB } from '@zamfono/shared';

import {
  decodeOffsetCursor,
  offsetPage,
  pageInput
} from '#lib/server/pagination.js';

import {
  contactPhoneE164,
  phoneDigits,
  tenantCountry
} from '../contacts/_shared.js';
import { defineOperation } from '../types.js';

type Hit = {
  kind: 'user' | 'ringGroup' | 'contact';
  id: string;
  label: string;
  matched: string;
};

function includes(haystack: string | null, needle: string): boolean {
  return haystack?.toLowerCase().includes(needle) ?? false;
}

/** The wire name of the first searched field whose value matches `needle`. */
function firstMatch(
  fields: { field: string; value: string | null; search: boolean }[],
  needle: string
): string | null {
  for (const { field, value, search } of fields) {
    if (search && includes(value, needle)) {
      return field;
    }
  }
  return null;
}

/** `ext` per `user_id`, for every extension a live user owns (§11.2). */
async function extensionsByUser(
  db: Transaction<DB>
): Promise<Map<string, string>> {
  const rows = await db
    .selectFrom('extensions')
    .select(['ext', 'userId'])
    .execute();
  const byUser = new Map<string, string>();
  for (const row of rows) {
    if (row.userId !== null) {
      byUser.set(row.userId, row.ext);
    }
  }
  return byUser;
}

/** `ext` per `ring_group_id`, for every extension a live ring group owns (§11.2). */
async function extensionsByRingGroup(
  db: Transaction<DB>
): Promise<Map<string, string>> {
  const rows = await db
    .selectFrom('extensions')
    .select(['ext', 'ringGroupId'])
    .execute();
  const byRingGroup = new Map<string, string>();
  for (const row of rows) {
    if (row.ringGroupId !== null) {
      byRingGroup.set(row.ringGroupId, row.ext);
    }
  }
  return byRingGroup;
}

// ponytail: matches over every live row in JS rather than a SQL LIKE, since a pasted number
// matches through its normalized forms (`phoneNeedles`); SQLite FTS5 is the spec's own upgrade
// path (§10.2 "Search") once a tenant's row count makes this scan slow.
async function searchUsers(
  db: Transaction<DB>,
  needle: string,
  includeEmail: boolean
): Promise<Hit[]> {
  const [users, exts] = await Promise.all([
    db
      .selectFrom('users')
      .select(['id', 'name', 'email'])
      .where('deletedAt', 'is', null)
      .execute(),
    extensionsByUser(db)
  ]);
  const hits: Hit[] = [];
  for (const user of users) {
    const ext = exts.get(user.id) ?? null;
    const matched = firstMatch(
      [
        { field: 'name', value: user.name, search: true },
        { field: 'extension', value: ext, search: true },
        { field: 'email', value: user.email, search: includeEmail }
      ],
      needle
    );
    if (matched) {
      hits.push({
        kind: 'user',
        id: user.id,
        label: ext ? `${user.name} · ${ext}` : user.name,
        matched
      });
    }
  }
  return hits;
}

async function searchRingGroups(
  db: Transaction<DB>,
  needle: string
): Promise<Hit[]> {
  const [groups, exts] = await Promise.all([
    db
      .selectFrom('ringGroups')
      .select(['id', 'name'])
      .where('deletedAt', 'is', null)
      .execute(),
    extensionsByRingGroup(db)
  ]);
  const hits: Hit[] = [];
  for (const group of groups) {
    const ext = exts.get(group.id) ?? null;
    const matched = firstMatch(
      [
        { field: 'name', value: group.name, search: true },
        { field: 'ext', value: ext, search: true }
      ],
      needle
    );
    if (matched) {
      hits.push({
        kind: 'ringGroup',
        id: group.id,
        label: ext ? `${group.name} · ${ext}` : group.name,
        matched
      });
    }
  }
  return hits;
}

/** `number[]` per `contact_id`, for every live contact's phones (§11.2 `contact_phones`). */
async function phonesByContact(
  db: Transaction<DB>
): Promise<Map<string, string[]>> {
  const rows = await db
    .selectFrom('contactPhones')
    .select(['contactId', 'number'])
    .execute();
  const byContact = new Map<string, string[]>();
  for (const row of rows) {
    const numbers = byContact.get(row.contactId) ?? [];
    numbers.push(row.number);
    byContact.set(row.contactId, numbers);
  }
  return byContact;
}

// A needle of digits and the separators a written number carries: `+`, spaces, `-`, `/`, `.`, `()`.
const PHONE_LIKE = /^\+?[\d\s()./-]+$/u;

/**
 * The forms a stored E.164 contact number may contain a pasted `needle` as: its bare digits, and
 * the number the tenant's dialling rules make of it ("01 2345678" → "+4312345678"). None when the
 * needle is no number.
 */
async function phoneNeedles(
  db: Transaction<DB>,
  needle: string
): Promise<string[]> {
  if (!PHONE_LIKE.test(needle)) {
    return [];
  }
  const digits = phoneDigits(needle);
  const e164 = contactPhoneE164(needle, await tenantCountry(db));
  return [...new Set([digits, e164 ?? digits])];
}

async function searchContacts(
  db: Transaction<DB>,
  needle: string
): Promise<Hit[]> {
  const [contacts, phones, numberNeedles] = await Promise.all([
    db
      .selectFrom('contacts')
      .select(['id', 'displayName', 'company'])
      .where('deletedAt', 'is', null)
      .execute(),
    phonesByContact(db),
    phoneNeedles(db, needle)
  ]);
  const hits: Hit[] = [];
  for (const contact of contacts) {
    const contactPhones = phones.get(contact.id) ?? [];
    const displayLabel = contactPhones[0]
      ? `${contact.displayName} · ${contactPhones[0]}`
      : contact.displayName;
    if (includes(contact.displayName, needle)) {
      hits.push({
        kind: 'contact',
        id: contact.id,
        label: displayLabel,
        matched: 'displayName'
      });
      continue;
    }
    if (includes(contact.company, needle)) {
      hits.push({
        kind: 'contact',
        id: contact.id,
        label: displayLabel,
        matched: 'company'
      });
      continue;
    }
    const matchedPhone = contactPhones.find(number =>
      numberNeedles.some(numberNeedle => number.includes(numberNeedle))
    );
    if (matchedPhone) {
      hits.push({
        kind: 'contact',
        id: contact.id,
        label: `${contact.displayName} · ${matchedPhone}`,
        matched: 'phones'
      });
    }
  }
  return hits;
}

const ADMIN_ROLES = new Set(['owner', 'admin']);

export const searchQuery = defineOperation({
  name: 'search.query',
  description:
    'The type-ahead behind the search bar: users, ring groups and contacts.',
  input: z
    .object({
      // eslint-disable-next-line id-length -- 'q' is the wire query-parameter name fixed by §10.3's `GET /search?q=`
      q: z
        .string()
        .min(1)
        .describe(
          "Text matched case-insensitively against users' names, extensions and (for admins) e-mails, ring groups' names and extensions, and contacts' names, companies and numbers."
        ),
      ...pageInput.shape
    })
    .strict(),
  minRole: 'user',
  readOnly: true,
  run: async (ctx, input) => {
    const offset = decodeOffsetCursor(ctx.operation, input.cursor);
    const needle = input.q.toLowerCase();
    const includeEmail = ADMIN_ROLES.has(ctx.actor.role);
    const [users, ringGroups, contacts] = await Promise.all([
      searchUsers(ctx.db, needle, includeEmail),
      searchRingGroups(ctx.db, needle),
      searchContacts(ctx.db, needle)
    ]);
    const hits = [...users, ...ringGroups, ...contacts];
    const { page, nextCursor } = offsetPage(
      ctx.operation,
      hits.slice(offset, offset + input.limit + 1),
      offset,
      input.limit
    );
    return { items: page, nextCursor };
  }
});
