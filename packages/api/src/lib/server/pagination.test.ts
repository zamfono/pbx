import { beforeAll, describe, expect, it } from 'vitest';

import type { Db } from '@zamfono/shared';

import { makeTestDb } from '#testing/testDb.js';

import {
  arrayPage,
  orderByInput,
  orderOf,
  pageInput,
  sqlPage,
  type Order
} from './pagination.js';

const LIST = 'contacts.list';

function tokenOf(position: unknown): string {
  return Buffer.from(JSON.stringify(position), 'utf8').toString('base64url');
}

function request(
  params: Record<string, unknown> = {}
): ReturnType<typeof pageInput.parse> & Record<string, unknown> {
  return { ...params, ...pageInput.parse(params) };
}

// Five contacts, two pairs of them sharing a name, so a page boundary falls inside a tie.
const NAMES = ['Bea', 'Anna', 'Bea', 'Carl', 'Anna'];

let db: Db;

beforeAll(async () => {
  db = await makeTestDb();
  await db
    .insertInto('contacts')
    .values(
      NAMES.map((displayName, index) => ({
        id: `c${index}`,
        displayName,
        createdAt: `2026-10-0${index + 1}T00:00:00.000Z`,
        updatedAt: '2026-10-01T00:00:00.000Z'
      }))
    )
    .execute();
});

/** Every page of `order` at `pageSize`, following the tokens, as the ids in page order. */
async function pagesOf(
  order: Order,
  params: Record<string, unknown>
): Promise<string[][]> {
  const pages: string[][] = [];
  let pageToken: string | undefined;
  do {
    // eslint-disable-next-line no-await-in-loop -- each page follows the token of the one before
    const { page, nextPageToken, totalSize } = await sqlPage(
      LIST,
      request({ ...params, pageToken }),
      db.selectFrom('contacts').selectAll(),
      order
    );
    expect(totalSize).toBe(NAMES.length);
    pages.push(page.map(row => row.id));
    pageToken = nextPageToken ?? undefined;
  } while (pageToken !== undefined);
  return pages;
}

describe('pagination', () => {
  it('defaults the page size to 50 and coerces a larger one to 200', () => {
    expect(pageInput.parse({}).pageSize).toBe(50);
    expect(pageInput.parse({ pageSize: 0 }).pageSize).toBe(50);
    expect(pageInput.parse({ pageSize: 201 }).pageSize).toBe(200);
    expect(pageInput.safeParse({ pageSize: -1 }).success).toBe(false);
  });

  it('pages through ties in order, each row once', async () => {
    const order = orderOf('displayName desc', []);
    expect(await pagesOf(order, { pageSize: 2 })).toEqual([
      ['c3', 'c2'],
      ['c0', 'c4'],
      ['c1']
    ]);
  });

  it('skips items from the start or from the token', async () => {
    const order: Order = [['id', 'asc']];
    const first = await sqlPage(
      LIST,
      request({ pageSize: 2, skip: 1 }),
      db.selectFrom('contacts').selectAll(),
      order
    );
    expect(first.page.map(row => row.id)).toEqual(['c1', 'c2']);
    const next = await sqlPage(
      LIST,
      request({
        pageSize: 2,
        skip: 1,
        pageToken: first.nextPageToken ?? undefined
      }),
      db.selectFrom('contacts').selectAll(),
      order
    );
    expect(next.page.map(row => row.id)).toEqual(['c4']);
    expect(next.nextPageToken).toBeNull();
  });

  it('cuts an array from the token and skip, and counts it whole', () => {
    const items = ['a', 'b', 'c', 'd', 'e'];
    const first = arrayPage(LIST, request({ pageSize: 2, skip: 1 }), items);
    expect(first).toMatchObject({ page: ['b', 'c'], totalSize: 5 });
    const next = arrayPage(
      LIST,
      request({ pageSize: 2, pageToken: first.nextPageToken ?? undefined }),
      items
    );
    expect(next).toMatchObject({ page: ['d', 'e'], nextPageToken: null });
  });

  it('refuses a token under other parameters or from another list with 422', async () => {
    const { nextPageToken } = arrayPage(
      LIST,
      request({ pageSize: 1, kind: 'a' }),
      ['a', 'b']
    );
    const pageToken = nextPageToken ?? '';
    expect(
      arrayPage(LIST, request({ pageSize: 1, kind: 'a', pageToken }), [
        'a',
        'b'
      ]).page
    ).toEqual(['b']);
    for (const [list, params] of [
      [LIST, { kind: 'b' }],
      [LIST, {}],
      ['dids.list', { kind: 'a' }]
    ] as const) {
      expect(() =>
        arrayPage(list, request({ ...params, pageToken }), [])
      ).toThrow(expect.objectContaining({ status: 422 }));
    }
    await expect(
      sqlPage(
        LIST,
        request({ kind: 'a', pageToken }),
        db.selectFrom('contacts').selectAll(),
        [['id', 'asc']]
      )
    ).rejects.toMatchObject({ status: 422 });
  });

  it.each(['not-a-token', tokenOf(null), tokenOf({}), tokenOf({ list: LIST })])(
    'refuses the malformed token %s with 422',
    pageToken => {
      expect(() => arrayPage(LIST, request({ pageToken }), [])).toThrow(
        expect.objectContaining({ status: 422 })
      );
    }
  );

  it('takes orderBy in AIP-132 form over its own fields only', () => {
    const orderBy = orderByInput(['displayName', 'createdAt'], 'by name');
    expect(orderBy.safeParse(' displayName desc , createdAt').success).toBe(
      true
    );
    expect(orderBy.safeParse('email').success).toBe(false);
    expect(orderBy.safeParse('displayName DESC').success).toBe(false);
    expect(orderOf(' displayName desc , createdAt', [])).toEqual([
      ['displayName', 'desc'],
      ['createdAt', 'asc'],
      ['id', 'asc']
    ]);
    expect(orderOf(undefined, [['id', 'desc']])).toEqual([['id', 'desc']]);
  });
});
