import { beforeEach, describe, expect, test } from 'vitest';

import '#lib/api/ops/index.js';

import { ApiError } from '#lib/api/errors.js';
import { call, type Actor } from '#lib/api/ops/core.js';
import { DID, MENU, NUM, RG, U } from '#lib/api/seed/ids.js';
import { resetDb, store } from '#lib/api/store.svelte.js';
import type { Did, DidBlock } from '#lib/api/types.js';

const admin: Actor = { id: U.jonas, name: 'Jonas Weber', role: 'admin' };
const user: Actor = { id: U.mira, name: 'Mira Kovač', role: 'user' };
const as = <O>(name: string, input: unknown, actor = admin): O =>
  call<O>(name, input, { actor, channel: 'ui', confirmed: true });

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

beforeEach(() => resetDb());

describe('dids', () => {
  test('lists live numbers for admins only', () => {
    expect(as<{ items: Did[] }>('dids.list', {}).items).toHaveLength(8);
    expect(refusal(() => as('dids.list', {}, user)).code).toBe('forbiddenRole');
  });

  test('normalises a national number to E.164 and keeps a provider string verbatim', () => {
    const national = as<Did>('dids.create', {
      number: '089452055',
      target: { kind: 'menu', menuId: MENU.haupt }
    });
    expect(national.number).toBe('+4989452055');
    const verbatim = as<Did>('dids.create', {
      number: 'acct-4711',
      target: { kind: 'menu', menuId: MENU.haupt }
    });
    expect(verbatim.number).toBe('acct-4711');
  });

  test('refuses whitespace and a number already in use', () => {
    expect(
      refusal(() =>
        as('dids.create', {
          number: '+49 89',
          target: { kind: 'menu', menuId: MENU.haupt }
        })
      ).code
    ).toBe('numbers.numberWhitespace');
    const clash = refusal(() =>
      as('dids.create', {
        number: '0894520101',
        target: { kind: 'menu', menuId: MENU.haupt }
      })
    );
    expect(clash.status).toBe(409);
    expect(clash.refs[0]?.id).toBe(DID.lea);
  });

  test('gives a user without caller ID their first numeric DID', () => {
    const tobias = store.db.users.find(row => row.id === U.tobias);
    expect(tobias?.callerIdDidId).toBeNull();
    const did = as<Did>('dids.create', {
      number: '+49894520110',
      target: { kind: 'user', userId: U.tobias }
    });
    expect(store.db.users.find(row => row.id === U.tobias)?.callerIdDidId).toBe(
      did.id
    );
    expect(
      store.db.audit[0]?.changes.some(
        change => change.field === 'callerIdDidId'
      )
    ).toBe(true);
  });

  test('updates the target only and refuses a missing target row', () => {
    const did = as<Did>('dids.update', {
      id: DID.hotline,
      target: { kind: 'ringGroup', ringGroupId: RG.empfang }
    });
    expect(did.target).toEqual({ kind: 'ringGroup', ringGroupId: RG.empfang });
    expect(
      refusal(() =>
        as('dids.update', {
          id: DID.hotline,
          target: { kind: 'user', userId: 'nobody' }
        })
      ).status
    ).toBe(404);
  });

  test('refuses deleting the main number and a number presented as caller ID', () => {
    expect(refusal(() => as('dids.delete', { id: DID.main })).code).toBe(
      'numbers.mainNumber'
    );
    const callerId = refusal(() => as('dids.delete', { id: DID.lea }));
    expect(callerId.code).toBe('numbers.callerIdOfUsers');
    expect(callerId.refs.map(ref => ref.id)).toEqual([U.lea]);
  });

  test('deletes a free number after confirmation', () => {
    expect(() =>
      call('dids.delete', { id: DID.hotline }, { actor: admin, channel: 'ui' })
    ).toThrow('confirmation required');
    as('dids.delete', { id: DID.hotline });
    expect(
      as<{ items: Did[] }>('dids.list', {}).items.some(
        row => row.id === DID.hotline
      )
    ).toBe(false);
  });
});

describe('didBlocks', () => {
  test('creates an open-ended block from a national base, refusing a wildcard', () => {
    const block = as<DidBlock>('didBlocks.create', {
      base: '0894521',
      digits: null
    });
    expect(block.base).toBe('+49894521');
    expect(block.digits).toBeNull();
    expect(refusal(() => as('didBlocks.create', { base: '+4989*' })).code).toBe(
      'numbers.baseWildcard'
    );
  });

  test('keeps the base on update and refuses deleting a block with numbers', () => {
    const block = store.db.didBlocks[0];
    const updated = as<DidBlock>('didBlocks.update', {
      id: block?.id,
      label: 'Neu',
      digits: 4,
      fallbackTarget: null
    });
    expect(updated.base).toBe(NUM.blockBase);
    expect(updated.fallbackTarget).toBeNull();
    as('didBlocks.update', { id: block?.id, digits: 3 });
    const refused = refusal(() => as('didBlocks.delete', { id: block?.id }));
    expect(refused.code).toBe('numbers.blockHasNumbers');
    expect(refused.refs.length).toBeGreaterThan(0);
  });
});
