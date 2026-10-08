/**
 * Personal access tokens (`ops/personalAccessTokens/`): bearer tokens a server application acts
 * as a user with. Each user manages their own; an admin anyone's but an owner's. The value is
 * returned once; creating and revoking are never undone (§5.8).
 */
import { conflict, invalid, notFound } from '../../errors';
import { newId } from '../../ids';
import type { Db, PersonalAccessToken } from '../../types';
import { defineOp, type Ctx } from '../core';
import { requireText } from '../validate';
import { liveUser, namesAnOwner, ownActingUser, randomFrom } from './users';

const NAME_MAX_LENGTH = 100;
const TOKEN_ALPHABET =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

function token(db: Db, id: string): PersonalAccessToken {
  const row = db.personalAccessTokens.find(candidate => candidate.id === id);
  if (row === undefined) {
    throw notFound('personalAccessToken', id);
  }
  return row;
}

/** `forAnOwner`: an owner's tokens are owner-only, like an owner's password. */
const forAnOwner = (ctx: Ctx, input: { userId: string }): boolean =>
  namesAnOwner(ctx, { id: input.userId });

/** `anOwnersToken`: a token of an owner's. */
const anOwnersToken = (ctx: Ctx, input: { id: string }): boolean =>
  ctx.db.users.find(user => user.id === token(ctx.db, input.id).userId)
    ?.role === 'owner';

defineOp<
  { userId: string; limit?: number; cursor?: string },
  { items: PersonalAccessToken[]; nextCursor: string | null }
>({
  name: 'personalAccessTokens.list',
  minRole: 'user',
  scope: ownActingUser,
  ownerOnly: forAnOwner,
  readOnly: true,
  run: (ctx, input) => {
    liveUser(ctx.db, input.userId);
    return {
      items: ctx.db.personalAccessTokens
        .filter(row => row.userId === input.userId)
        .sort((a, b) => a.id.localeCompare(b.id)),
      nextCursor: null
    };
  }
});

defineOp<
  { userId: string; name: string; expiresAt?: string | null },
  PersonalAccessToken & { token: string }
>({
  name: 'personalAccessTokens.create',
  minRole: 'user',
  scope: ownActingUser,
  ownerOnly: forAnOwner,
  run: (ctx, input) => {
    const db = ctx.db;
    const user = liveUser(db, input.userId);
    // `mayLogIn`: an e-mail, and for an owner a password.
    if (user.email === null || (user.role === 'owner' && !user.passwordSet)) {
      throw conflict(
        'people.tokenCannotLogIn',
        'personalAccessTokens: this user cannot log in',
        [{ kind: 'user', id: user.id, label: user.name }]
      );
    }
    const name = requireText('name', input.name);
    if (name.length > NAME_MAX_LENGTH) {
      throw invalid('name', 'people.tokenNameLength', 'name too long', {
        max: NAME_MAX_LENGTH
      });
    }
    let expiresAt: string | null = null;
    if (
      input.expiresAt !== undefined &&
      input.expiresAt !== null &&
      input.expiresAt !== ''
    ) {
      const at = Date.parse(input.expiresAt);
      if (Number.isNaN(at)) {
        throw invalid(
          'expiresAt',
          'people.tokenExpiryInvalid',
          'expiresAt must be ISO 8601'
        );
      }
      expiresAt = new Date(at).toISOString();
      if (expiresAt <= ctx.now) {
        throw invalid(
          'expiresAt',
          'people.tokenExpiryPast',
          'personalAccessTokens: expiresAt must lie in the future'
        );
      }
    }
    // An expired token's name is free again: it is revoked first.
    for (const row of db.personalAccessTokens) {
      if (
        row.userId === user.id &&
        row.name === name &&
        row.revokedAt === null &&
        row.expiresAt !== null &&
        row.expiresAt <= ctx.now
      ) {
        row.revokedAt = ctx.now;
      }
    }
    const taken = db.personalAccessTokens.find(
      row =>
        row.userId === user.id && row.name === name && row.revokedAt === null
    );
    if (taken !== undefined) {
      throw conflict(
        'people.tokenNameTaken',
        'personalAccessTokens: name taken',
        [{ kind: 'personalAccessToken', id: taken.id, label: taken.name }]
      );
    }
    const value = `zpat_${randomFrom(TOKEN_ALPHABET, 43)}`;
    const row: PersonalAccessToken = {
      id: newId(),
      userId: user.id,
      name,
      prefix: value.slice(0, 9),
      expiresAt,
      lastUsedAt: null,
      createdAt: ctx.now,
      revokedAt: null
    };
    ctx.insert('personalAccessTokens', row);
    ctx.audit({
      entityKind: 'personalAccessToken',
      entityId: row.id,
      changes: [
        { field: 'userId', from: null, to: user.id },
        { field: 'name', from: null, to: name },
        { field: 'expiresAt', from: null, to: expiresAt }
      ],
      undoable: false
    });
    return { ...row, token: value };
  }
});

defineOp<{ id: string }, PersonalAccessToken>({
  name: 'personalAccessTokens.revoke',
  minRole: 'user',
  scope: (ctx, input) => token(ctx.db, input.id).userId === ctx.actor.id,
  ownerOnly: anOwnersToken,
  confirm: (ctx, input) => ({
    key: 'personalAccessTokens.revoke',
    params: { name: token(ctx.db, input.id).name },
    destructive: true,
    irreversible: true
  }),
  run: (ctx, input) => {
    const before = token(ctx.db, input.id);
    if (before.revokedAt !== null) {
      throw conflict(
        'people.tokenRevoked',
        'personalAccessTokens: already revoked'
      );
    }
    const after = { ...before, revokedAt: ctx.now };
    ctx.put('personalAccessTokens', after);
    ctx.audit({
      entityKind: 'personalAccessToken',
      entityId: after.id,
      changes: [{ field: 'revokedAt', from: null, to: ctx.now }],
      undoable: false
    });
    return after;
  }
});
