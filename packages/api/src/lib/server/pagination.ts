import {
  sql,
  type Expression,
  type SelectQueryBuilder,
  type SqlBool
} from 'kysely';
import { z } from 'zod';

import { HTTP_UNPROCESSABLE_CONTENT, isRecord } from '@zamfono/shared';

import { sha256Hex } from './hash.js';
import { OpError } from './ops/types.js';

// §10.3 "Conventions": list endpoints page as Google's AIP-158 and AIP-132 have it. A request
// takes `pageSize`, `pageToken` and `skip` (and `orderBy` where a list sorts); the answer is
// `{ items, nextPageToken, totalSize }`. A token names the list operation that handed it out and
// a hash of the request's other parameters, so another list's token, or this list's under other
// filters or another order, is refused; it resumes after a row's sort values (keyset) or, for a
// list cut from an array, at an offset. base64url just keeps the wire form opaque.
const TOKEN_ENCODING = 'base64url';
const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;
const REQUEST_HASH_LENGTH = 16;
const PAGING_FIELDS = new Set(['pageSize', 'pageToken', 'skip']);

/** The `{ pageSize, pageToken, skip }` input every list operation takes. */
export const pageInput = z.object({
  pageSize: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe(
      `Items per page: ${DEFAULT_PAGE_SIZE} when left out or 0, at most ${MAX_PAGE_SIZE}; a larger value counts as ${MAX_PAGE_SIZE}.`
    )
    .transform(size =>
      size === undefined || size === 0
        ? DEFAULT_PAGE_SIZE
        : Math.min(size, MAX_PAGE_SIZE)
    ),
  pageToken: z
    .string()
    .optional()
    .describe(
      "The previous page's nextPageToken, with the request's other parameters unchanged."
    ),
  skip: z
    .number()
    .int()
    .nonnegative()
    .default(0)
    .describe('Items to skip, counted from the page token or the start.')
});

type PageRequest = z.output<typeof pageInput> & Record<string, unknown>;

/** The `output` of a list operation: one page of `item`s, the token to the next and the total. */
export function pageOutput<Item extends z.ZodType>(
  item: Item
): z.ZodObject<{
  items: z.ZodArray<Item>;
  nextPageToken: z.ZodNullable<z.ZodString>;
  totalSize: z.ZodNumber;
}> {
  return z.object({
    items: z.array(item),
    nextPageToken: z
      .string()
      .nullable()
      .describe('The pageToken of the next page; null on the last.'),
    totalSize: z
      .number()
      .int()
      .describe(
        "The items on every page together, after the request's filters."
      )
  });
}

/** One page of a list, before its rows become the operation's items. */
export type Page<Row> = {
  page: Row[];
  nextPageToken: string | null;
  totalSize: number;
};

/**
 * A sort order: columns, qualified where a join needs it, with their directions; the last one
 * unique (a row id).
 */
export type Order = readonly (readonly [
  column: string,
  direction: 'asc' | 'desc'
])[];

// The request's parameters other than the paging ones, in a canonical form, hashed: a token is
// only valid for the request that earned it (AIP-158).
function requestHash(input: PageRequest): string {
  const params = Object.keys(input)
    .filter(key => !PAGING_FIELDS.has(key) && input[key] !== undefined)
    .sort()
    .map(key => [key, input[key]]);
  return sha256Hex(JSON.stringify(params)).slice(0, REQUEST_HASH_LENGTH);
}

function encodeToken(
  list: string,
  input: PageRequest,
  position: object
): string {
  return Buffer.from(
    JSON.stringify({ list, request: requestHash(input), ...position }),
    'utf8'
  ).toString(TOKEN_ENCODING);
}

function invalidToken(): OpError {
  return new OpError(HTTP_UNPROCESSABLE_CONTENT, 'invalid page token');
}

// A token only ever arrives back as this same request's previous `nextPageToken`, so anything
// else, another list's token or this list's under other parameters, is refused with 422.
function decodeToken(
  list: string,
  input: PageRequest
): Record<string, unknown> | undefined {
  if (input.pageToken === undefined) {
    return undefined;
  }
  let position: unknown;
  try {
    position = JSON.parse(
      Buffer.from(input.pageToken, TOKEN_ENCODING).toString('utf8')
    );
  } catch {
    throw invalidToken();
  }
  if (
    !isRecord(position) ||
    position.list !== list ||
    position.request !== requestHash(input)
  ) {
    throw invalidToken();
  }
  return position;
}

/**
 * A page of the array `items`, the whole ordered list, for a list `list` (its operation name)
 * cut in memory: from the token's offset, or the start, plus `skip`.
 */
export function arrayPage<Item>(
  list: string,
  input: PageRequest,
  items: readonly Item[]
): Page<Item> {
  const offset = decodeToken(list, input)?.offset ?? 0;
  if (
    typeof offset !== 'number' ||
    !Number.isSafeInteger(offset) ||
    offset < 0
  ) {
    throw invalidToken();
  }
  const start = offset + input.skip;
  const end = start + input.pageSize;
  return {
    page: items.slice(start, end),
    nextPageToken:
      end < items.length ? encodeToken(list, input, { offset: end }) : null,
    totalSize: items.length
  };
}

/** The rows after `after`, the last row's values of `order`'s columns, in `order`. */
function after(order: Order, values: readonly unknown[]): Expression<SqlBool> {
  const ors = order.map(([column, direction], index) => {
    const equal = order
      .slice(0, index)
      .map(([prior], at) => sql`${sql.ref(prior)} = ${values[at]}`);
    const beyond =
      direction === 'asc'
        ? sql`${sql.ref(column)} > ${values[index]}`
        : sql`${sql.ref(column)} < ${values[index]}`;
    return sql`(${sql.join([...equal, beyond], sql` and `)})`;
  });
  return sql<SqlBool>`(${sql.join(ors, sql` or `)})`;
}

/**
 * A keyset page of list `list` (its operation name): `query`, filtered but neither ordered nor
 * limited, sorted by `order`, whose columns must be non-null and selected; resumed after the
 * token's row, or at the start, plus `skip`. `totalSize` counts `query`'s rows.
 */
export async function sqlPage<DB, TB extends keyof DB, Row extends object>(
  list: string,
  input: PageRequest,
  query: SelectQueryBuilder<DB, TB, Row>,
  order: Order
): Promise<Page<Row>> {
  const values = decodeToken(list, input)?.after;
  if (
    input.pageToken !== undefined &&
    (!Array.isArray(values) || values.length !== order.length)
  ) {
    throw invalidToken();
  }
  const { totalSize } = await query
    .clearSelect()
    .select(sql<number>`count(*)`.as('totalSize'))
    .$castTo<{ totalSize: number }>()
    .executeTakeFirstOrThrow();
  let paged = Array.isArray(values) ? query.where(after(order, values)) : query;
  for (const [column, direction] of order) {
    paged = paged.orderBy(sql.ref(column), direction);
  }
  const rows = await paged
    .offset(input.skip)
    .limit(input.pageSize + 1)
    .execute();
  const page = rows.slice(0, input.pageSize);
  const last = page.at(-1);
  return {
    page,
    nextPageToken:
      rows.length > input.pageSize && isRecord(last)
        ? encodeToken(list, input, {
            after: order.map(([column]) => last[column.split('.').at(-1) ?? ''])
          })
        : null,
    totalSize
  };
}

const ORDER_TERM = /^\s*(?<field>\w+)(?:\s+(?<desc>desc))?\s*$/u;

/**
 * The `orderBy` input of a list sortable by `fields` (AIP-132): a comma-separated list of them,
 * each ascending unless followed by ` desc`.
 */
export function orderByInput(
  fields: readonly string[],
  defaultOrder: string
): z.ZodOptional<z.ZodString> {
  return z
    .string()
    .refine(
      value =>
        value
          .split(',')
          .every(term =>
            fields.includes(ORDER_TERM.exec(term)?.groups?.field ?? '')
          ),
      `orderBy takes ${fields.join(', ')}, each optionally followed by " desc"`
    )
    .optional()
    .describe(
      `The sort order: a comma-separated list of ${fields.join(', ')}, each ascending unless followed by " desc"; left out, ${defaultOrder}.`
    );
}

/**
 * The `Order` of a validated `orderBy`, whose fields are column names, then `id` in the last
 * term's direction so rows that tie are ordered too; `fallback` without one.
 */
export function orderOf(orderBy: string | undefined, fallback: Order): Order {
  if (orderBy === undefined) {
    return fallback;
  }
  const order = orderBy.split(',').map(term => {
    const groups = ORDER_TERM.exec(term)?.groups;
    return [groups?.field ?? '', groups?.desc ? 'desc' : 'asc'] as const;
  });
  const last = order.at(-1)?.[1] ?? 'asc';
  return order.some(([column]) => column === 'id')
    ? order
    : [...order, ['id', last]];
}
