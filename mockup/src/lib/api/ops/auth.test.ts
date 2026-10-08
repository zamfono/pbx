import { beforeEach, describe, expect, it } from 'vitest';

import { ApiError } from '../errors';
import { seed } from '../seed';
import { U } from '../seed/ids';
import { store } from '../store.svelte';
import { call, type Actor } from './core';

import './areas/auth';

import type { MfaChangeResult, MfaStatus } from './areas/auth';

const lea: Actor = { id: U.lea, name: 'Lea Brandt', role: 'owner' };
const jonas: Actor = { id: U.jonas, name: 'Jonas Weber', role: 'admin' };
const mira: Actor = { id: U.mira, name: 'Mira Kovač', role: 'user' };

const as = <O>(actor: Actor, name: string, input: unknown): O =>
  call<O>(name, input, { actor, channel: 'ui' });

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

const mfaOf = (id: string) => store.db.users.find(user => user.id === id)?.mfa;

describe('auth.* (own second factors)', () => {
  beforeEach(() => {
    store.db = seed();
  });

  it('reports the caller’s own methods and whether one is required', () => {
    const status = as<MfaStatus>(lea, 'auth.status', { userId: U.lea });
    expect(status.totp).toBe(true);
    expect(status.passkeys).toHaveLength(1);
    expect(status.required).toBe(true);
    expect(
      as<MfaStatus>(mira, 'auth.status', { userId: U.mira }).required
    ).toBe(false);
  });

  it('acts on the caller’s own account only, whatever the role', () => {
    expect(refusal(() => as(mira, 'auth.status', { userId: U.lea })).code).toBe(
      'forbiddenNotOwn'
    );
    expect(
      refusal(() => as(lea, 'auth.totpRemove', { userId: U.jonas })).code
    ).toBe('forbidden');
  });

  it('issues ten recovery codes with the first method, none with a later one', () => {
    const first = as<MfaChangeResult>(mira, 'auth.totpConfirm', {
      userId: U.mira,
      code: '123456'
    });
    expect(first.codes).toHaveLength(10);
    expect(first.codes?.[0]).toMatch(/^[A-Z2-7]{4}(-[A-Z2-7]{4}){3}$/u);
    expect(mfaOf(U.mira)).toEqual({
      totp: true,
      passkeys: 0,
      recoveryCodesLeft: 10
    });
    const second = as<MfaChangeResult>(mira, 'auth.passkeyAdd', {
      userId: U.mira,
      name: '  '
    });
    expect(second.codes).toBeNull();
    expect(store.db.passkeys.at(-1)?.name).toBe('Passkey');
    expect(mfaOf(U.mira)?.passkeys).toBe(1);
  });

  it('refuses a malformed authenticator code', () => {
    expect(
      refusal(() =>
        as(mira, 'auth.totpConfirm', { userId: U.mira, code: '12ab56' })
      ).code
    ).toBe('auth.invalidCode');
  });

  it('keeps the last method of a person who must have one', () => {
    expect(
      refusal(() => as(jonas, 'auth.totpRemove', { userId: U.jonas })).code
    ).toBe('auth.lastMethod');
    as(jonas, 'auth.passkeyAdd', { userId: U.jonas, name: 'iPhone' });
    as(jonas, 'auth.totpRemove', { userId: U.jonas });
    expect(mfaOf(U.jonas)).toEqual({
      totp: false,
      passkeys: 1,
      recoveryCodesLeft: 10
    });
  });

  it('removes the recovery codes with the last method of a person who need not keep one', () => {
    as(mira, 'auth.totpConfirm', { userId: U.mira, code: '123456' });
    as(mira, 'auth.totpRemove', { userId: U.mira });
    expect(mfaOf(U.mira)).toEqual({
      totp: false,
      passkeys: 0,
      recoveryCodesLeft: 0
    });
  });

  it('generates new recovery codes only once a method exists', () => {
    expect(
      refusal(() => as(mira, 'auth.recoveryCodes', { userId: U.mira })).code
    ).toBe('auth.codesNeedMethod');
    const { codes } = as<{ codes: string[] }>(lea, 'auth.recoveryCodes', {
      userId: U.lea
    });
    expect(new Set(codes).size).toBe(10);
    expect(mfaOf(U.lea)?.recoveryCodesLeft).toBe(10);
  });

  it('uses up a recovery code at the second step and stamps a passkey’s last use', () => {
    as(lea, 'auth.secondFactor', {
      userId: U.lea,
      method: 'recovery',
      code: 'abcd efgh ijkl mnop'
    });
    expect(mfaOf(U.lea)?.recoveryCodesLeft).toBe(8);
    const before = store.db.passkeys.find(
      passkey => passkey.userId === U.lea
    )?.lastUsedAt;
    as(lea, 'auth.secondFactor', { userId: U.lea, method: 'passkey' });
    expect(
      store.db.passkeys.find(passkey => passkey.userId === U.lea)?.lastUsedAt
    ).not.toBe(before);
    expect(
      refusal(() =>
        as(jonas, 'auth.secondFactor', { userId: U.jonas, method: 'passkey' })
      ).code
    ).toBe('auth.passkeyFailed');
  });

  it('writes no audit entry', () => {
    const entries = store.db.audit.length;
    as(lea, 'auth.passkeyAdd', { userId: U.lea, name: 'YubiKey' });
    expect(store.db.audit).toHaveLength(entries);
  });
});
