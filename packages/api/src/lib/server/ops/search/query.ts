import { z } from 'zod';

import { nationalForm, type CountryCode, type Db } from '@zamfono/shared';

import { arrayPage, pageInput, pageOutput } from '#lib/server/pagination.js';

import { phoneDigits, tenantCountry } from '../contacts/_shared.js';
import { defineOperation } from '../types.js';

const hit = z.object({
  kind: z.enum(['user', 'ringGroup', 'decision', 'menu', 'contact']),
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

/** `ext` per owner id, for every extension `column`'s owners hold (§11.2): live by construction,
 * since a soft delete deletes the owner's extension. */
async function extensionsBy(
  db: Db,
  column: 'userId' | 'ringGroupId' | 'decisionId' | 'menuId'
): Promise<Map<string, string>> {
  const rows = await db
    .selectFrom('extensions')
    .select(['ext', column])
    .where(column, 'is not', null)
    .execute();
  return new Map(rows.map(row => [String(row[column]), row.ext]));
}

// ponytail: matches over every live row in JS rather than a SQL LIKE, since a pasted number
// matches through its normalized forms (`phoneNeedles`); SQLite FTS5 is the spec's own upgrade
// path (§10.2 "Search") once a tenant's row count makes this scan slow.
async function searchUsers(
  db: Db,
  needle: string,
  includeEmail: boolean
): Promise<Hit[]> {
  const [users, exts] = await Promise.all([
    db
      .selectFrom('users')
      .select(['id', 'name', 'email'])
      .where('deletedAt', 'is', null)
      .execute(),
    extensionsBy(db, 'userId')
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

/** The named entities whose name or extension matches `needle`: ring groups, and decisions and
 * menus, which a `user` finds only with an extension, nothing else of them being theirs to use
 * (§10.2 "Search"). */
async function searchNamed(
  db: Db,
  needle: string,
  source: {
    kind: 'ringGroup' | 'decision' | 'menu';
    table: 'ringGroups' | 'decisions' | 'menus';
    column: 'ringGroupId' | 'decisionId' | 'menuId';
    withoutExtension: boolean;
  }
): Promise<Hit[]> {
  const [rows, exts] = await Promise.all([
    db
      .selectFrom(source.table)
      .select(['id', 'name'])
      .where('deletedAt', 'is', null)
      .execute(),
    extensionsBy(db, source.column)
  ]);
  const hits: Hit[] = [];
  for (const row of rows) {
    const ext = exts.get(row.id) ?? null;
    const matched = firstMatch(
      [
        { field: 'name', value: row.name, search: true },
        { field: 'ext', value: ext, search: true }
      ],
      needle
    );
    if (matched && (ext !== null || source.withoutExtension)) {
      hits.push({
        kind: source.kind,
        id: row.id,
        label: ext ? `${row.name} · ${ext}` : row.name,
        matched
      });
    }
  }
  return hits;
}

/** `number[]` per `contact_id`, for every live contact's phones (§11.2 `contact_phones`). */
async function phonesByContact(db: Db): Promise<Map<string, string[]>> {
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
  db: Db,
  needle: string
): Promise<{ digits: string; country: CountryCode } | null> {
  return PHONE_LIKE.test(needle)
    ? { digits: phoneDigits(needle), country: await tenantCountry(db) }
    : null;
}

/** The contacts whose name, company or one of whose numbers matches the lowercase `needle`. */
export async function searchContacts(db: Db, needle: string): Promise<Hit[]> {
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
    'The type-ahead behind the search bar: users, ring groups, decisions, menus and contacts.',
  input: z
    .object({
      // eslint-disable-next-line id-length -- 'q' is the wire query-parameter name fixed by §10.3's `GET /search?q=`
      q: z
        .string()
        .min(1)
        .describe(
          "Text matched case-insensitively against users' names, extensions and (for admins) e-mails, the names and extensions of ring groups, decisions and menus (for users only those with an extension), and contacts' names, companies and numbers."
        ),
      ...pageInput.shape
    })
    .strict(),
  output: pageOutput(hit),
  minRole: 'user',
  scope: 'any',
  readOnly: true,
  run: async (ctx, input) => {
    const needle = input.q.toLowerCase();
    const isAdmin = ADMIN_ROLES.has(ctx.actor.role);
    const [users, ringGroups, decisions, menus, contacts] = await Promise.all([
      searchUsers(ctx.db, needle, isAdmin),
      searchNamed(ctx.db, needle, {
        kind: 'ringGroup',
        table: 'ringGroups',
        column: 'ringGroupId',
        withoutExtension: true
      }),
      searchNamed(ctx.db, needle, {
        kind: 'decision',
        table: 'decisions',
        column: 'decisionId',
        withoutExtension: isAdmin
      }),
      searchNamed(ctx.db, needle, {
        kind: 'menu',
        table: 'menus',
        column: 'menuId',
        withoutExtension: isAdmin
      }),
      searchContacts(ctx.db, needle)
    ]);
    const hits = [...users, ...ringGroups, ...decisions, ...menus, ...contacts];
    const { page, nextPageToken, totalSize } = arrayPage(
      ctx.operation,
      input,
      hits
    );
    return { items: page, nextPageToken, totalSize };
  }
});
