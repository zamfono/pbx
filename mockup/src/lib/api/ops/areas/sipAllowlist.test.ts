import { beforeEach, describe, expect, it } from 'vitest';

import '#lib/api/ops/index.js';

import { ApiError } from '#lib/api/errors.js';
import { call, ConfirmationRequired, type Actor } from '#lib/api/ops/core.js';
import { U } from '#lib/api/seed/ids.js';
import { resetDb, store } from '#lib/api/store.svelte.js';

import type { SipBanWire } from './sipBans';

const jonas: Actor = { id: U.jonas, name: 'Jonas Weber', role: 'admin' };
const run = <O>(name: string, input: unknown, confirmed = false): O =>
  call<O>(name, input, { actor: jonas, channel: 'ui', confirmed });

function refusal(fn: () => unknown): ApiError {
  try {
    fn();
  } catch (error) {
    if (error instanceof ApiError) {
      return error;
    }
    throw error;
  }
  throw new Error('expected a refusal');
}

beforeEach(() => {
  resetDb();
});

describe('SIP protection', () => {
  it('lists bans by state and lifts an active one, not undoable', () => {
    const active = run<{ items: SipBanWire[] }>('sipBans.list', {}).items;
    expect(active.map(ban => ban.address).sort()).toEqual([
      '185.243.5.117',
      '45.134.26.89'
    ]);
    expect(
      run<{ items: SipBanWire[] }>('sipBans.list', { state: 'ended' }).items
    ).toHaveLength(1);
    const ban = active[0];
    expect(() => run('sipBans.lift', { id: ban?.id })).toThrow(
      ConfirmationRequired
    );
    run('sipBans.lift', { id: ban?.id }, true);
    expect(store.db.audit[0]).toMatchObject({
      operation: 'sipBans.lift',
      undoable: false
    });
    expect(refusal(() => run('sipBans.lift', { id: ban?.id }, true)).code).toBe(
      'sipBanEnded'
    );
  });

  it('an allowlist entry ends the bans it covers; duplicates and bad addresses are refused', () => {
    expect(
      refusal(() => run('sipAllowlist.create', { address: 'office' })).code
    ).toBe('sipAllowlistAddress');
    expect(
      refusal(() => run('sipAllowlist.create', { address: '198.51.100.17' }))
        .code
    ).toBe('duplicate');
    run('sipAllowlist.create', { address: '45.134.26.0/24', label: 'Partner' });
    const active = run<{ items: SipBanWire[] }>('sipBans.list', {}).items;
    expect(active.map(ban => ban.address)).toEqual(['185.243.5.117']);
    const lifted = store.db.sipBans.find(
      ban => ban.address === '45.134.26.89'
    ) as SipBanWire | undefined;
    expect(lifted?.liftedBy).toBe(U.jonas);
  });
});
