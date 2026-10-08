import { beforeEach, describe, expect, test } from 'vitest';

import '#lib/api/ops/index.js';

import { ApiError } from '#lib/api/errors.js';
import type { RouteWire } from '#lib/api/ops/areas/outboundRoutes.js';
import { call, type Actor } from '#lib/api/ops/core.js';
import { DID, ROUTE, TRUNK, U, UG } from '#lib/api/seed/ids.js';
import { resetDb } from '#lib/api/store.svelte.js';
import type { Did } from '#lib/api/types.js';

const admin: Actor = { id: U.jonas, name: 'Jonas Weber', role: 'admin' };
const as = <O>(name: string, input: unknown): O =>
  call<O>(name, input, { actor: admin, channel: 'ui', confirmed: true });

function refusal(run: () => unknown): ApiError {
  try {
    run();
  } catch (error) {
    if (error instanceof ApiError) {
      return error;
    }
    throw error;
  }
  throw new Error('expected a refusal');
}

const route = (extra: object = {}): object => ({
  trunkId: TRUNK.nordwind,
  users: [],
  userGroups: [],
  numbers: [],
  ...extra
});

beforeEach(() => resetDb());

describe('outboundRoutes', () => {
  test('replaces the list in order, keeping ids and adding new routes', () => {
    const { items } = as<{ items: RouteWire[] }>('outboundRoutes.replace', {
      routes: [
        route({
          userGroups: [UG.buchhaltung],
          numbers: [{ number: '+43', isPrefix: true }],
          callerIdDidId: DID.buchhaltung
        }),
        route({ id: ROUTE.catchAll, callerIdDidId: DID.main })
      ]
    });
    expect(items.map(item => item.priority)).toEqual([1, 2]);
    expect(items[1]?.id).toBe(ROUTE.catchAll);
    expect(items[0]?.numbers).toEqual([{ number: '+43', isPrefix: true }]);
  });

  test('refuses what the API refuses', () => {
    expect(
      refusal(() =>
        as('outboundRoutes.replace', { routes: [route({ trunkId: 'gone' })] })
      ).code
    ).toBe('outboundRoutes.trunkUnknown');
    expect(
      refusal(() =>
        as('outboundRoutes.replace', {
          routes: [route({ numbers: [{ number: '0049' }] })]
        })
      ).code
    ).toBe('outboundRoutes.numberE164');
    expect(
      refusal(() =>
        as('outboundRoutes.replace', {
          routes: [route({ users: [U.lea, U.lea] })]
        })
      ).code
    ).toBe('outboundRoutes.duplicateUser');
    expect(
      refusal(() =>
        as('outboundRoutes.replace', { routes: [route({ users: ['nobody'] })] })
      ).code
    ).toBe('outboundRoutes.callerUnknown');
    const verbatim = as<Did>('dids.create', {
      number: 'acct-4711',
      target: { kind: 'user', userId: U.lea }
    });
    expect(
      refusal(() =>
        as('outboundRoutes.replace', {
          routes: [route({ callerIdDidId: verbatim.id })]
        })
      ).code
    ).toBe('outboundRoutes.didNotNumeric');
  });
});
