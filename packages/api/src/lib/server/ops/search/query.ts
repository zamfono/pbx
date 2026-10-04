import type { Transaction } from 'kysely';
import { z } from 'zod';

import { nationalForm, type CountryCode, type DB } from '@zamfono/shared';

import {
  decodeOffsetCursor,
  offsetPage,
  pageInput,
  pageOutput
} from '#lib/server/pagination.js';

import { phoneDigits, tenantCountry } from '../contacts/_shared.js';
import { defineOperation } from '../types.js';

const hit = z.object({
  kind: z.enum(['user', 'ringGroup', 'contact']),
  id: z.string(),
  label: z.string(),
  matched: z.string().describe('The field the text matched in.')
});
type Hit = z.infer<typeof hit>;

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
 * Whether a pasted `digits`, a fragment of a number as written, is part of the stored E.164
 * `number`: of its international form ("+49 89 12", "89 12") or of its national digits as dialled
 * in `country` ("(089) 12"). Nothing is resolved, so a fragment matches without being a number.
 */
function phoneMatches(
  number: string,
  digits: string,
  country: CountryCode
): boolean {
  return (
    number.includes(digits) || nationalForm(number, country).includes(digits)
  );
}

/** A phone-like `needle`'s digits with the tenant's country, `null` for any other needle. */
async function phoneNeedle(
  db: Transaction<DB>,
  needle: string
): Promise<{ digits: string; country: CountryCode } | null> {
  return PHONE_LIKE.test(needle)
    ? { digits: phoneDigits(needle), country: await tenantCountry(db) }
    : null;
}

async function searchContacts(
  db: Transaction<DB>,
  needle: string
): Promise<Hit[]> {
  const [contacts, phones, numberNeedle] = await Promise.all([
    db
      .selectFrom('contacts')
      .select(['id', 'displayName', 'company'])
      .where('deletedAt', 'is', null)
      .execute(),
    phonesByContact(db),
    phoneNeedle(db, needle)
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
    const matchedPhone =
      numberNeedle &&
      contactPhones.find(number =>
        phoneMatches(number, numberNeedle.digits, numberNeedle.country)
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
  output: pageOutput(hit),
  minRole: 'user',
  scope: 'any',
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
