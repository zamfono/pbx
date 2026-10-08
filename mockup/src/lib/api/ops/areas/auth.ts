/**
 * The person's own second factors (§5.2 "Two-factor authentication"): the second step of a
 * password sign-in and the security page (`/auth/security`). These are browser pages of the API,
 * no REST operations, so the names carry the mock-only prefix `auth.`. Every operation acts on the
 * caller's own account only — no operation sets up a method for somebody else — and none is
 * audited: the API mails the person instead (`mfaChanged`).
 *
 * Rules: owners and admins must keep a second factor, every user once `mfaRequiredForAll` is set;
 * the first method set up issues ten single-use recovery codes; removing the last method of a
 * person who need not keep one removes the recovery codes with it.
 */
import { conflict, forbidden, invalid, notFound } from '../../errors';
import { newId } from '../../ids';
import type { Db, Passkey, User } from '../../types';
import { defineOp, type Ctx } from '../core';

export const RECOVERY_CODE_COUNT = 10;
const MAX_PASSKEY_NAME = 100;
/** A passkey's name when the person gives none (the same word in German and English). */
const PASSKEY_DEFAULT_NAME = 'Passkey';
const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const CODE_GROUPS = 4;
const GROUP_LENGTH = 4;

type Own = { userId: string };

/** What the security page shows of the caller's methods; never a secret. */
export type MfaStatus = {
  totp: boolean;
  passkeys: Passkey[];
  recoveryCodesLeft: number;
  /** Whether this person must keep a second factor. */
  required: boolean;
};

/** A write that may have issued recovery codes (the first method set up), shown once. */
export type MfaChangeResult = { codes: string[] | null };

const own = (ctx: Ctx, input: Own): boolean => input.userId === ctx.actor.id;

/** Whether a user of `role` must pass a second factor at every password sign-in. */
export function mfaRequired(db: Db, user: Pick<User, 'role'>): boolean {
  return (
    user.role === 'owner' ||
    user.role === 'admin' ||
    db.settings.mfaRequiredForAll
  );
}

/** Whether `user` holds a method that passes the second step on its own (recovery codes are a
 * fallback, never the method itself). */
export function hasMfa(user: Pick<User, 'mfa'>): boolean {
  return user.mfa.totp || user.mfa.passkeys > 0;
}

/** A fresh recovery code: 80 random bits, base32 in dash-separated groups, `ABCD-EFGH-IJKL-MNOP`. */
function newRecoveryCode(): string {
  const bytes = new Uint8Array(CODE_GROUPS * GROUP_LENGTH);
  crypto.getRandomValues(bytes);
  const chars = Array.from(bytes, byte => BASE32[byte % BASE32.length]).join(
    ''
  );
  return (
    chars.match(new RegExp(`.{${GROUP_LENGTH}}`, 'gu'))?.join('-') ?? chars
  );
}

/** `code` as typed, reduced to the characters that carry it: case and separators do not count. */
export function normalizedRecoveryCode(code: string): string {
  return code.toUpperCase().replaceAll(/[^A-Z2-7]/gu, '');
}

/** The caller's own live user row; 403 for anyone else's. */
function ownUser(ctx: Ctx, userId: string): User {
  if (userId !== ctx.actor.id) {
    throw forbidden('only the person sets up their own second factors');
  }
  const user = ctx.db.users.find(
    candidate => candidate.id === userId && candidate.deletedAt === null
  );
  if (user === undefined) {
    throw notFound('user', userId);
  }
  return user;
}

function setMfa(ctx: Ctx, user: User, mfa: User['mfa']): void {
  ctx.put('users', { ...user, mfa });
}

/** Ten fresh codes replacing the user's previous ones. */
function issueCodes(ctx: Ctx, userId: string): string[] {
  const codes = Array.from({ length: RECOVERY_CODE_COUNT }, newRecoveryCode);
  const user = ownUser(ctx, userId);
  setMfa(ctx, user, { ...user.mfa, recoveryCodesLeft: RECOVERY_CODE_COUNT });
  return codes;
}

/** Stores a new method through `store`, issuing recovery codes when it is the first one. */
function added(
  ctx: Ctx,
  userId: string,
  store: (user: User) => void
): MfaChangeResult {
  const first = !hasMfa(ownUser(ctx, userId));
  store(ownUser(ctx, userId));
  return { codes: first ? issueCodes(ctx, userId) : null };
}

/** Removes a method through `remove`, unless it is the last one of a person who must keep one;
 * the recovery codes go with the last method, which they no longer stand in for. */
function removed(ctx: Ctx, userId: string, remove: (user: User) => void): void {
  const user = ownUser(ctx, userId);
  const after = user.mfa.passkeys + (user.mfa.totp ? 1 : 0) - 1;
  if (after <= 0 && mfaRequired(ctx.db, user)) {
    throw conflict('auth.lastMethod', 'the account must keep a second factor');
  }
  remove(user);
  if (after <= 0) {
    const current = ownUser(ctx, userId);
    setMfa(ctx, current, { ...current.mfa, recoveryCodesLeft: 0 });
  }
}

defineOp<Own, MfaStatus>({
  name: 'auth.status',
  minRole: 'user',
  scope: own,
  readOnly: true,
  run: (ctx, input) => {
    const user = ownUser(ctx, input.userId);
    return {
      totp: user.mfa.totp,
      passkeys: ctx.db.passkeys.filter(passkey => passkey.userId === user.id),
      recoveryCodesLeft: user.mfa.recoveryCodesLeft,
      required: mfaRequired(ctx.db, user)
    };
  }
});

/**
 * The second step of a sign-in: an authenticator code (any six digits in the demo), a passkey
 * (the browser's prompt, simulated), or a recovery code, which is used up.
 */
defineOp<
  Own & {
    method: 'totp' | 'passkey' | 'recovery';
    code?: string;
    passkeyId?: string;
  },
  { ok: true }
>({
  name: 'auth.secondFactor',
  minRole: 'user',
  scope: own,
  run: (ctx, input) => {
    const user = ownUser(ctx, input.userId);
    if (input.method === 'totp') {
      if (
        !user.mfa.totp ||
        !/^\d{6}$/u.test((input.code ?? '').replaceAll(/\s/gu, ''))
      ) {
        throw invalid('code', 'auth.invalidCode', 'incorrect code');
      }
      return { ok: true };
    }
    if (input.method === 'recovery') {
      const valid =
        normalizedRecoveryCode(input.code ?? '').length ===
        CODE_GROUPS * GROUP_LENGTH;
      if (!valid || user.mfa.recoveryCodesLeft === 0) {
        throw invalid('code', 'auth.invalidCode', 'incorrect code');
      }
      setMfa(ctx, user, {
        ...user.mfa,
        recoveryCodesLeft: user.mfa.recoveryCodesLeft - 1
      });
      return { ok: true };
    }
    const passkey = ctx.db.passkeys.find(
      candidate =>
        candidate.userId === user.id &&
        (input.passkeyId === undefined || candidate.id === input.passkeyId)
    );
    if (passkey === undefined) {
      throw invalid(
        'passkey',
        'auth.passkeyFailed',
        'the passkey could not be verified'
      );
    }
    passkey.lastUsedAt = ctx.now;
    return { ok: true };
  }
});

/** Confirms a new or replacing authenticator app with its first code (any six digits in the demo). */
defineOp<Own & { code: string }, MfaChangeResult>({
  name: 'auth.totpConfirm',
  minRole: 'user',
  scope: own,
  run: (ctx, input) => {
    if (!/^\d{6}$/u.test(input.code.replaceAll(/\s/gu, ''))) {
      throw invalid('code', 'auth.invalidCode', 'incorrect code');
    }
    return added(ctx, input.userId, user =>
      setMfa(ctx, user, { ...user.mfa, totp: true })
    );
  }
});

defineOp<Own, { removed: true }>({
  name: 'auth.totpRemove',
  minRole: 'user',
  scope: own,
  run: (ctx, input) => {
    const user = ownUser(ctx, input.userId);
    if (!user.mfa.totp) {
      throw notFound('totp', input.userId);
    }
    removed(ctx, input.userId, current =>
      setMfa(ctx, current, { ...current.mfa, totp: false })
    );
    return { removed: true };
  }
});

/** A passkey registered through the browser's prompt, named by the person (default "Passkey"). */
defineOp<Own & { name?: string }, MfaChangeResult & { passkey: Passkey }>({
  name: 'auth.passkeyAdd',
  minRole: 'user',
  scope: own,
  run: (ctx, input) => {
    const name =
      (input.name ?? '').trim().slice(0, MAX_PASSKEY_NAME) ||
      PASSKEY_DEFAULT_NAME;
    const passkey: Passkey = {
      id: newId(),
      userId: input.userId,
      name,
      createdAt: ctx.now,
      lastUsedAt: null
    };
    const result = added(ctx, input.userId, user => {
      ctx.db.passkeys.push(passkey);
      setMfa(ctx, user, { ...user.mfa, passkeys: user.mfa.passkeys + 1 });
    });
    return { ...result, passkey };
  }
});

defineOp<Own & { id: string }, { removed: Passkey }>({
  name: 'auth.passkeyRemove',
  minRole: 'user',
  scope: own,
  run: (ctx, input) => {
    ownUser(ctx, input.userId);
    const index = ctx.db.passkeys.findIndex(
      row => row.id === input.id && row.userId === input.userId
    );
    const passkey = ctx.db.passkeys[index];
    if (passkey === undefined) {
      throw notFound('passkey', input.id);
    }
    removed(ctx, input.userId, user => {
      ctx.db.passkeys.splice(index, 1);
      setMfa(ctx, user, {
        ...user.mfa,
        passkeys: Math.max(0, user.mfa.passkeys - 1)
      });
    });
    return { removed: passkey };
  }
});

/** Ten new recovery codes, replacing the old ones; shown once. Needs a method to stand in for. */
defineOp<Own, { codes: string[] }>({
  name: 'auth.recoveryCodes',
  minRole: 'user',
  scope: own,
  run: (ctx, input) => {
    if (!hasMfa(ownUser(ctx, input.userId))) {
      throw conflict(
        'auth.codesNeedMethod',
        'set up an authenticator app or a passkey first'
      );
    }
    return { codes: issueCodes(ctx, input.userId) };
  }
});
