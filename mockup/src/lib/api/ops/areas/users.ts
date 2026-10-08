/**
 * Users (`ops/users/`): the people of the tenant, their forwarding, presence and personal
 * voicemail greeting. Admins write every field; a `user` reads and writes their own record, only
 * the self-service subset (`_updateAccess.ts`). An owner's account, password, second factor and
 * tokens are owner-only; only an owner gives a role other than `user` or changes one.
 */
import {
  ApiError,
  conflict,
  invalid,
  notFound,
  type BlockingRef
} from '../../errors';
import { newId } from '../../ids';
import { allTargets } from '../../lookup';
import {
  ROLES,
  SELF_SERVICE_USER_FIELDS,
  USER_FORWARD_CONDITIONS,
  type AudioAsset,
  type Db,
  type FindMeLeg,
  type ForwardTarget,
  type LogLevelOverride,
  type PresenceStatus,
  type Role,
  type User,
  type UserForwardCondition,
  type UserForwardRule
} from '../../types';
import { defineOp, type ConfirmInfo, type Ctx } from '../core';
import {
  E164,
  normaliseNumber,
  requireFreeExtension,
  requireText,
  requireTimeout
} from '../validate';

/* ---------------- shared helpers (also used by devices and tokens) ---------------- */

const MAX_TIMEOUT_S = 86_400;
const SEVEN_DAYS_MS = 7 * 86_400_000;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;
const ALPHANUMERIC =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

/** `length` random characters of `alphabet` (tokens, passwords, slugs). */
export function randomFrom(alphabet: string, length: number): string {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, byte => alphabet[byte % alphabet.length]).join('');
}

/** The live user `id` names, or 404. */
export function liveUser(db: Db, id: string): User {
  const user = db.users.find(
    candidate => candidate.id === id && candidate.deletedAt === null
  );
  if (user === undefined) {
    throw notFound('user', id);
  }
  return user;
}

/** `namesAnOwner`: an owner's account is owner-only (§10.3). 404 for no live user. */
export const namesAnOwner = (ctx: Ctx, input: { id: string }): boolean =>
  liveUser(ctx.db, input.id).role === 'owner';

/** `ownUserId`: the caller's own id alone. */
export const ownUserId = (ctx: Ctx, input: { id: string }): boolean =>
  input.id === ctx.actor.id;

/** `ownActingUser`: acting for the caller themselves (or left out). */
export const ownActingUser = (ctx: Ctx, input: { userId?: string }): boolean =>
  input.userId === undefined || input.userId === ctx.actor.id;

/** A 403 with its own i18n code: the API's message names the refused field or rule. */
export const forbiddenCode = (
  code: string,
  message: string,
  params: Record<string, string> = {}
): ApiError => new ApiError(403, code, message, { params });

const userRef = (user: User): BlockingRef => ({
  kind: 'user',
  id: user.id,
  label: user.name
});

/** The confirmation of a soft delete (`softDeleteQuestion`): undoable for the retention days. */
export function softDeleteConfirm(
  ctx: Ctx,
  key: string,
  what: string
): ConfirmInfo {
  const days = ctx.db.settings.softDeleteRetentionDays;
  return days === null
    ? { key: `${key}.anytime`, params: { what }, destructive: true }
    : { key, params: { what, days }, destructive: true };
}

/** `isAdminTarget`: a `sip` target, or an `external` one that records. */
export const isAdminTarget = (target: ForwardTarget): boolean =>
  target.kind === 'sip' || (target.kind === 'external' && target.record);

/** `assertMayHoldTarget` (`forwardTargets.ts`): an admin target is set by an admin or owner alone. */
export function assertMayHoldTarget(ctx: Ctx, target: ForwardTarget): void {
  if (isAdminTarget(target) && ctx.actor.role === 'user') {
    throw target.kind === 'sip'
      ? forbiddenCode(
          'people.sipTargetAdminOnly',
          'a sip target is set by an admin'
        )
      : forbiddenCode(
          'people.recordTargetAdminOnly',
          'a recording target is set by an admin'
        );
  }
}

const liveRow = (
  rows: { id: string; deletedAt: string | null }[],
  id: string
): boolean => rows.some(row => row.id === id && row.deletedAt === null);

/** A forward target as `insertForwardTarget` checks it: what it points at is live (404), an
 * external number is E.164 (422). Returns the target with the number normalised. */
export function checkTarget(
  db: Db,
  target: ForwardTarget,
  field: string
): ForwardTarget {
  switch (target.kind) {
    case 'user':
    case 'mailboxUser':
      if (!liveRow(db.users, target.userId)) {
        throw notFound('user', target.userId);
      }
      return target;
    case 'ringGroup':
    case 'mailboxRingGroup':
      if (!liveRow(db.ringGroups, target.ringGroupId)) {
        throw notFound('ringGroup', target.ringGroupId);
      }
      return target;
    case 'external': {
      const external = normaliseNumber(db, target.external.trim());
      if (!E164.test(external)) {
        throw invalid(field, 'e164', 'external must be E.164', {
          value: target.external
        });
      }
      return { ...target, external };
    }
    case 'sip':
      if (!liveRow(db.trunks, target.trunkId)) {
        throw notFound('trunk', target.trunkId);
      }
      return target;
    case 'announcement':
      if (!liveRow(db.audio, target.audioId)) {
        throw notFound('audio', target.audioId);
      }
      return target;
    case 'menu':
      if (!liveRow(db.menus, target.menuId)) {
        throw notFound('menu', target.menuId);
      }
      return target;
  }
}

/* ---------------- field checks ---------------- */

function checkEmail(value: unknown): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  const email = String(value).trim();
  if (!EMAIL.test(email)) {
    throw invalid('email', 'people.email', 'email must be an e-mail address', {
      value: email
    });
  }
  return email;
}

/** `assertContact`: an e-mail, an extension or both; an e-mail for an owner or admin. */
function assertContact(
  user: { role: Role; email: string | null; extension: string | null },
  status: 409 | 422
): void {
  const fail = (code: string, message: string): never => {
    throw status === 422
      ? invalid('email', code, message, { role: user.role })
      : conflict(code, message, [], { role: user.role });
  };
  if (user.email === null && user.extension === null) {
    fail(
      'people.needsContact',
      'users: a user needs an e-mail or an extension'
    );
  }
  if (user.email === null && user.role !== 'user') {
    fail('people.roleNeedsEmail', `users: an ${user.role} needs an e-mail`);
  }
}

function assertEmailAvailable(db: Db, email: string, excludeId?: string): void {
  const holder = db.users.find(
    user =>
      user.deletedAt === null &&
      user.id !== excludeId &&
      user.email?.toLowerCase() === email.toLowerCase()
  );
  if (holder !== undefined) {
    throw conflict(
      'people.emailTaken',
      'users: e-mail already in use',
      [userRef(holder)],
      { email }
    );
  }
}

/** `findMeSchema` plus `assertFindMeNotOwnDid`. */
function checkFindMe(db: Db, legs: unknown): FindMeLeg[] {
  if (!Array.isArray(legs)) {
    throw invalid('findMe', 'invalid', 'findMe must be a list', {
      message: 'findMe'
    });
  }
  const checked = (legs as FindMeLeg[]).map(leg => {
    const number = normaliseNumber(db, String(leg.number ?? '').trim());
    if (!E164.test(number)) {
      throw invalid('findMe', 'e164', 'number must be E.164', {
        value: String(leg.number ?? '')
      });
    }
    if (
      !Number.isInteger(leg.delayS) ||
      leg.delayS < 0 ||
      leg.delayS > MAX_TIMEOUT_S
    ) {
      throw invalid('findMe', 'range', 'delayS out of range', {
        min: 0,
        max: MAX_TIMEOUT_S
      });
    }
    return { number, delayS: leg.delayS };
  });
  const own = checked.find(leg =>
    db.dids.some(did => did.deletedAt === null && did.number === leg.number)
  );
  if (own !== undefined) {
    throw invalid(
      'findMe',
      'people.findMeOwnDid',
      `findMe: ${own.number} is one of your own numbers`,
      {
        number: own.number
      }
    );
  }
  return checked;
}

function checkMaxMessages(value: unknown): number | null {
  if (value === null) {
    return null;
  }
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw invalid(
      'mailboxMaxMessages',
      'range',
      'mailboxMaxMessages must be a positive integer',
      {
        min: 1,
        max: 100_000
      }
    );
  }
  return value;
}

/** `assertCallerIdDidValid`: a live, numeric DID. */
function checkCallerIdDid(db: Db, id: string): void {
  const did = db.dids.find(
    candidate => candidate.id === id && candidate.deletedAt === null
  );
  if (did === undefined) {
    throw invalid(
      'callerIdDidId',
      'people.callerIdUnknown',
      `unknown or deleted DID: ${id}`
    );
  }
  if (!E164.test(did.number)) {
    throw invalid(
      'callerIdDidId',
      'people.callerIdNotNumeric',
      `callerIdDidId must be a numeric DID: ${id}`
    );
  }
}

/** `assertAudioOfKind(…, 'vmGreeting')`. */
function checkGreetingAudio(db: Db, id: string): void {
  const asset = db.audio.find(
    candidate => candidate.id === id && candidate.deletedAt === null
  );
  if (asset === undefined || asset.kind !== 'vmGreeting') {
    throw invalid(
      'mailboxAudioId',
      'people.greetingKind',
      'mailboxAudioId must be a vmGreeting audio asset'
    );
  }
}

/** `assertNotLastOwner`: never below one live owner who can log in (has a password). */
function assertNotLastOwner(db: Db, user: User): void {
  if (user.role !== 'owner' || !user.passwordSet) {
    return;
  }
  const other = db.users.some(
    candidate =>
      candidate.id !== user.id &&
      candidate.deletedAt === null &&
      candidate.role === 'owner' &&
      candidate.passwordSet
  );
  if (!other) {
    throw conflict(
      'people.lastOwner',
      "cannot remove the tenant's last owner",
      [userRef(user)]
    );
  }
}

/** A one-time set-password link, `https://<FQDN>/auth/setPassword?token=…` (`_setupMail.ts`). */
function setPasswordLink(db: Db): string {
  return `https://${db.system.stack.domain}/auth/setPassword?token=${randomFrom(ALPHANUMERIC, 43)}`;
}

/** Revokes every live personal access token of `userId` (sessions and tokens end; never undone). */
function revokeTokens(ctx: Ctx, userId: string): void {
  for (const token of ctx.db.personalAccessTokens) {
    if (token.userId === userId && token.revokedAt === null) {
      token.revokedAt = ctx.now;
    }
  }
}

/* ---------------- reads ---------------- */

defineOp<
  { limit?: number; cursor?: string },
  { items: User[]; nextCursor: string | null }
>({
  name: 'users.list',
  minRole: 'admin',
  readOnly: true,
  run: ctx => ({
    items: ctx.db.users
      .filter(user => user.deletedAt === null)
      .sort((a, b) => a.name.localeCompare(b.name)),
    nextCursor: null
  })
});

defineOp<{ id: string }, User>({
  name: 'users.get',
  minRole: 'user',
  scope: ownUserId,
  readOnly: true,
  run: (ctx, input) => liveUser(ctx.db, input.id)
});

/* ---------------- create ---------------- */

export type UserCreateInput = {
  name: string;
  email?: string | null;
  role?: Role;
  extension?: string | null;
  ringTimeoutS?: number;
  clir?: boolean | null;
  rejectAnonymous?: boolean | null;
  recordCalls?: boolean;
  notifyMissedCalls?: boolean;
  mailboxEnabled?: boolean;
  mailboxMaxMessages?: number | null;
  findMe?: FindMeLeg[];
};

defineOp<UserCreateInput, { user: User; setupLink: string | null }>({
  name: 'users.create',
  minRole: 'admin',
  // Only an owner brings an admin or an owner into being (§10.3).
  ownerOnly: (_ctx, input) => input.role !== undefined && input.role !== 'user',
  run: (ctx, input) => {
    const db = ctx.db;
    const name = requireText('name', input.name);
    const email = checkEmail(input.email === '' ? null : input.email);
    const role = input.role ?? 'user';
    if (!ROLES.includes(role)) {
      throw invalid('role', 'invalid', 'unknown role', {
        message: String(role)
      });
    }
    const rawExtension =
      input.extension === '' ? null : (input.extension ?? null);
    assertContact({ role, email, extension: rawExtension }, 422);
    const extension =
      rawExtension === null
        ? null
        : requireFreeExtension(db, 'extension', rawExtension);
    if (email !== null) {
      assertEmailAvailable(db, email);
    }
    const findMe = checkFindMe(db, input.findMe ?? []);
    const user: User = {
      id: newId(),
      name,
      email,
      role,
      extension,
      ringTimeoutS:
        input.ringTimeoutS === undefined
          ? 25
          : requireTimeout('ringTimeoutS', input.ringTimeoutS),
      clir: input.clir ?? null,
      rejectAnonymous: input.rejectAnonymous ?? null,
      notifyMissedCalls: input.notifyMissedCalls ?? true,
      findMe,
      recordCalls: input.recordCalls ?? false,
      mailboxEnabled: input.mailboxEnabled ?? true,
      mailboxAudioId: null,
      mailboxMaxMessages:
        input.mailboxMaxMessages === undefined
          ? 100
          : checkMaxMessages(input.mailboxMaxMessages),
      callerIdDidId: null,
      logLevel: null,
      logLevelExpiresAt: null,
      dnd: false,
      lockedUntil: null,
      mfa: { totp: false, passkeys: 0, recoveryCodesLeft: 0 },
      passwordSet: false,
      ssoBound: false,
      createdAt: ctx.now,
      deletedAt: null
    };
    ctx.insert('users', user);
    if (extension !== null) {
      db.presence[user.id] = {
        userId: user.id,
        status: 'offline',
        since: ctx.now,
        peer: null,
        ringGroupId: null
      };
    }
    ctx.audit({
      entityKind: 'user',
      entityId: user.id,
      changes: [
        { field: 'name', from: null, to: name },
        { field: 'email', from: null, to: email },
        { field: 'extension', from: null, to: extension }
      ]
    });
    // A user without an e-mail cannot log in (§5.2), so has no password to set.
    return { user, setupLink: email === null ? null : setPasswordLink(db) };
  }
});

/* ---------------- update ---------------- */

export type UserUpdateInput = {
  id: string;
  name?: string;
  email?: string | null;
  role?: Role;
  extension?: string | null;
  ringTimeoutS?: number;
  clir?: boolean | null;
  rejectAnonymous?: boolean | null;
  recordCalls?: boolean;
  notifyMissedCalls?: boolean;
  mailboxEnabled?: boolean;
  mailboxMaxMessages?: number | null;
  mailboxAudioId?: string | null;
  callerIdDidId?: string | null;
  findMe?: FindMeLeg[];
  logLevel?: LogLevelOverride | null;
  logLevelExpiresAt?: string | null;
};

export type AffectedDevice = { id: string; sipUsername: string };

/** `assertExtensionRemovable`: a user's devices are named after the extension, and only a user
 * with one rings in a ring group. */
function assertExtensionRemovable(db: Db, userId: string): void {
  const devices = db.devices.filter(
    device => device.userId === userId && device.deletedAt === null
  );
  if (devices.length > 0) {
    throw conflict(
      'people.extensionHasDevices',
      "users: the extension names the user's devices; remove them first",
      devices.map(device => ({
        kind: 'device',
        id: device.id,
        label: device.label
      }))
    );
  }
  const groups = db.ringGroups.filter(
    group =>
      group.deletedAt === null &&
      group.members.some(
        member => member.kind === 'user' && member.id === userId
      )
  );
  if (groups.length > 0) {
    throw conflict(
      'people.extensionInRingGroups',
      'users: the user is a member of ring groups; remove them first',
      groups.map(group => ({
        kind: 'ringGroup',
        id: group.id,
        label: group.name
      }))
    );
  }
}

/** Moves BLF keys watching `from` to `to` (or drops them for `to: null`), recorded for undo. */
function moveBlfKeys(ctx: Ctx, from: string, to: string | null): void {
  ctx.db.blf.forEach((entry, index) => {
    if (entry?.keys.includes(from) === true) {
      const keys =
        to === null
          ? entry.keys.filter(key => key !== from)
          : entry.keys.map(key => (key === from ? to : key));
      ctx.setKey('blf', String(index), { ...entry, keys });
    }
  });
}

/** Renames the user's live devices `e<old>-…` → `e<new>-…` (§9.3 "Naming"). */
function renameDevices(
  ctx: Ctx,
  userId: string,
  from: string,
  to: string
): AffectedDevice[] {
  const oldPrefix = `e${from}-`;
  return ctx.db.devices
    .filter(device => device.userId === userId && device.deletedAt === null)
    .map(device => {
      const sipUsername = device.sipUsername.startsWith(oldPrefix)
        ? `e${to}-${device.sipUsername.slice(oldPrefix.length)}`
        : device.sipUsername;
      ctx.put('devices', { ...device, sipUsername });
      return { id: device.id, sipUsername };
    });
}

/** `resolveLogLevel` (§7): `null` clears; a level without an expiry ends 7 days later. */
function resolveLogLevel(
  ctx: Ctx,
  before: User,
  input: UserUpdateInput
): Pick<User, 'logLevel' | 'logLevelExpiresAt'> {
  if (input.logLevel === undefined && input.logLevelExpiresAt === undefined) {
    return {
      logLevel: before.logLevel,
      logLevelExpiresAt: before.logLevelExpiresAt
    };
  }
  if (input.logLevel === null) {
    return { logLevel: null, logLevelExpiresAt: null };
  }
  const level = input.logLevel ?? before.logLevel;
  if (level === null) {
    throw invalid(
      'logLevelExpiresAt',
      'people.logLevelExpiry',
      'logLevelExpiresAt needs a logLevel to expire'
    );
  }
  return {
    logLevel: level,
    logLevelExpiresAt:
      input.logLevelExpiresAt ??
      new Date(Date.parse(ctx.now) + SEVEN_DAYS_MS).toISOString()
  };
}

defineOp<
  UserUpdateInput,
  { user: User; affectedDevices?: AffectedDevice[]; setupLink?: string }
>({
  name: 'users.update',
  minRole: 'user',
  scope: ownUserId,
  run: (ctx, input) => {
    const db = ctx.db;
    // `assertAllowedFields`: a user writes only their self-service fields.
    if (ctx.actor.role === 'user') {
      for (const key of Object.keys(input)) {
        if (
          key !== 'id' &&
          !(SELF_SERVICE_USER_FIELDS as readonly string[]).includes(key)
        ) {
          throw forbiddenCode(
            'people.adminOnlyField',
            `users: '${key}' is admin-only`,
            { field: key }
          );
        }
      }
    }
    const before = liveUser(db, input.id);
    // `assertRoleChangeAllowed`: only owners change roles; never the last owner who can log in.
    if (input.role !== undefined && input.role !== before.role) {
      if (ctx.actor.role !== 'owner') {
        throw forbiddenCode(
          'people.onlyOwnersChangeRoles',
          'users: only owners change roles'
        );
      }
      assertNotLastOwner(db, before);
    }
    // `assertEmailChangeAllowed`: an owner's e-mail is owner-only.
    const email =
      input.email === undefined
        ? before.email
        : checkEmail(input.email === '' ? null : input.email);
    if (
      input.email !== undefined &&
      email !== before.email &&
      before.role === 'owner' &&
      ctx.actor.role !== 'owner'
    ) {
      throw forbiddenCode(
        'people.ownerEmailOwnerOnly',
        "users: only owners change an owner's e-mail"
      );
    }
    if (email !== null && email !== before.email) {
      assertEmailAvailable(db, email, before.id);
    }
    if (input.callerIdDidId !== undefined && input.callerIdDidId !== null) {
      checkCallerIdDid(db, input.callerIdDidId);
    }
    const findMe =
      input.findMe === undefined
        ? before.findMe
        : checkFindMe(db, input.findMe);
    if (input.mailboxAudioId !== undefined && input.mailboxAudioId !== null) {
      checkGreetingAudio(db, input.mailboxAudioId);
    }

    // `planExtensionChange`
    const nextExtension = input.extension === '' ? null : input.extension;
    const extensionChanges =
      nextExtension !== undefined && nextExtension !== before.extension;
    let extension = before.extension;
    if (extensionChanges) {
      if (nextExtension === null) {
        assertExtensionRemovable(db, before.id);
        extension = null;
      } else {
        extension = requireFreeExtension(db, 'extension', nextExtension, {
          kind: 'user',
          id: before.id
        });
      }
    }
    const role = input.role ?? before.role;
    assertContact({ role, email, extension }, 409);

    const after: User = {
      ...before,
      name:
        input.name === undefined
          ? before.name
          : requireText('name', input.name),
      email,
      role,
      extension,
      ringTimeoutS:
        input.ringTimeoutS === undefined
          ? before.ringTimeoutS
          : requireTimeout('ringTimeoutS', input.ringTimeoutS),
      clir: input.clir === undefined ? before.clir : input.clir,
      rejectAnonymous:
        input.rejectAnonymous === undefined
          ? before.rejectAnonymous
          : input.rejectAnonymous,
      recordCalls: input.recordCalls ?? before.recordCalls,
      notifyMissedCalls: input.notifyMissedCalls ?? before.notifyMissedCalls,
      mailboxEnabled: input.mailboxEnabled ?? before.mailboxEnabled,
      mailboxMaxMessages:
        input.mailboxMaxMessages === undefined
          ? before.mailboxMaxMessages
          : checkMaxMessages(input.mailboxMaxMessages),
      mailboxAudioId:
        input.mailboxAudioId === undefined
          ? before.mailboxAudioId
          : input.mailboxAudioId,
      callerIdDidId:
        input.callerIdDidId === undefined
          ? before.callerIdDidId
          : input.callerIdDidId,
      findMe,
      ...resolveLogLevel(ctx, before, input)
    };

    // `promoteWithoutPassword`: a new owner without a password logs in only once they set one.
    let setupLink: string | undefined;
    if (role === 'owner' && before.role !== 'owner' && !before.passwordSet) {
      revokeTokens(ctx, before.id);
      setupLink = setPasswordLink(db);
    }
    // `dropLoginWithEmail`: without an e-mail nobody logs in.
    if (before.email !== null && email === null) {
      revokeTokens(ctx, before.id);
      after.passwordSet = false;
      after.ssoBound = false;
    }

    let affectedDevices: AffectedDevice[] | undefined;
    if (extensionChanges && before.extension !== null) {
      if (extension === null) {
        moveBlfKeys(ctx, before.extension, null);
      } else {
        affectedDevices = renameDevices(
          ctx,
          before.id,
          before.extension,
          extension
        );
        moveBlfKeys(ctx, before.extension, extension);
      }
    } else if (extensionChanges) {
      affectedDevices = [];
    }
    if (extensionChanges) {
      if (extension === null) {
        delete db.presence[before.id];
      } else if (db.presence[before.id] === undefined) {
        db.presence[before.id] = {
          userId: before.id,
          status: 'offline',
          since: ctx.now,
          peer: null,
          ringGroupId: null
        };
      }
    }
    ctx.put('users', after);
    ctx.audit({ entityKind: 'user', entityId: after.id, before, after });
    return {
      user: after,
      ...(affectedDevices !== undefined && affectedDevices.length > 0
        ? { affectedDevices }
        : {}),
      ...(setupLink !== undefined ? { setupLink } : {})
    };
  }
});

/* ---------------- delete, erase ---------------- */

/** `findUserReferences`: forward targets pointing at the user, except their own rules and their
 * own schedules, which go with them. */
function userReferences(db: Db, userId: string): BlockingRef[] {
  const own = (kind: string, id: string): boolean => {
    if (kind === 'user') {
      return id === userId;
    }
    if (kind === 'oooRule') {
      const rule = db.oooRules.find(candidate => candidate.id === id);
      return rule?.scope.kind === 'user' && rule.scope.id === userId;
    }
    if (kind === 'openingHours') {
      const hours = db.openingHours.find(candidate => candidate.id === id);
      return hours?.scope.kind === 'user' && hours.scope.id === userId;
    }
    return false;
  };
  const refs = new Map<string, BlockingRef>();
  for (const { owner, target } of allTargets()) {
    const pointsAtUser =
      (target.kind === 'user' || target.kind === 'mailboxUser') &&
      target.userId === userId;
    if (pointsAtUser && !own(owner.kind, owner.id)) {
      refs.set(`${owner.kind}:${owner.id}`, owner);
    }
  }
  return [...refs.values()];
}

function assertDeletable(db: Db, user: User): void {
  assertNotLastOwner(db, user);
  const refs = userReferences(db, user.id);
  if (refs.length > 0) {
    throw conflict('inUse', 'user is still in use', refs);
  }
}

/** `cascadeSoftDeleteUser` (§5.9): devices, extension (and BLF keys watching it), sessions,
 * tokens and second factors. */
function cascadeSoftDelete(ctx: Ctx, user: User): void {
  const db = ctx.db;
  for (const device of db.devices.filter(
    candidate => candidate.userId === user.id && candidate.deletedAt === null
  )) {
    ctx.softDelete('devices', device.id);
  }
  if (user.extension !== null) {
    moveBlfKeys(ctx, user.extension, null);
  }
  ctx.put('users', {
    ...user,
    extension: null,
    dnd: false,
    deletedAt: ctx.now
  });
  delete db.presence[user.id];
  // Tokens and second factors are never revived by an undo (§5.8): written outside the revert.
  revokeTokens(ctx, user.id);
  db.passkeys = db.passkeys.filter(passkey => passkey.userId !== user.id);
}

defineOp<{ id: string }, { id: string }>({
  name: 'users.delete',
  minRole: 'admin',
  ownerOnly: namesAnOwner,
  confirm: (ctx, input) => {
    const user = liveUser(ctx.db, input.id);
    return softDeleteConfirm(
      ctx,
      'users.delete',
      user.extension === null ? user.name : `${user.name} (${user.extension})`
    );
  },
  run: (ctx, input) => {
    const user = liveUser(ctx.db, input.id);
    assertDeletable(ctx.db, user);
    const before = { ...user };
    cascadeSoftDelete(ctx, user);
    ctx.audit({
      entityKind: 'user',
      entityId: user.id,
      before,
      after: { ...before, extension: null, deletedAt: ctx.now }
    });
    return { id: user.id };
  }
});

const MASKED = '***';
const PERSONAL_FIELDS = new Set(['name', 'email', 'findMe', 'rules']);

defineOp<{ id: string }, { id: string }>({
  name: 'users.erase',
  minRole: 'owner',
  confirm: (ctx, input) => ({
    key: 'users.erase',
    params: {
      name: ctx.db.users.find(user => user.id === input.id)?.name ?? input.id
    },
    destructive: true,
    irreversible: true
  }),
  run: (ctx, input) => {
    const db = ctx.db;
    const user = db.users.find(
      candidate => candidate.id === input.id && candidate.deletedAt === null
    );
    if (user !== undefined) {
      assertDeletable(db, user);
      cascadeSoftDelete(ctx, user);
    }
    for (const entry of db.audit) {
      if (entry.actorUserId === input.id) {
        entry.actorUserName = 'erased user';
      }
      if (entry.entityKind === 'user' && entry.entityId === input.id) {
        entry.changes = entry.changes.map(change =>
          PERSONAL_FIELDS.has(change.field)
            ? { field: change.field, from: MASKED, to: MASKED }
            : change
        );
        entry.undoable = false;
      }
    }
    // `maskContent`: the erasure's own entry carries no personal data either.
    ctx.audit({
      entityKind: 'user',
      entityId: input.id,
      changes: [{ field: 'deletedAt', from: MASKED, to: MASKED }],
      undoable: false
    });
    return { id: input.id };
  }
});

/* ---------------- password, second factor ---------------- */

defineOp<{ id: string }, { link: string }>({
  name: 'users.resetPassword',
  minRole: 'admin',
  ownerOnly: namesAnOwner,
  run: (ctx, input) => {
    const user = liveUser(ctx.db, input.id);
    if (user.email === null) {
      throw conflict(
        'people.noEmail',
        'users: a user without an e-mail cannot log in, so has no password to set',
        [userRef(user)]
      );
    }
    ctx.audit({
      entityKind: 'user',
      entityId: user.id,
      changes: [],
      pure: true
    });
    return { link: setPasswordLink(ctx.db) };
  }
});

defineOp<{ id: string }, { id: string }>({
  name: 'users.resetMfa',
  minRole: 'admin',
  ownerOnly: namesAnOwner,
  confirm: (ctx, input) => ({
    key: 'users.resetMfa',
    params: { name: liveUser(ctx.db, input.id).name },
    destructive: true,
    irreversible: true
  }),
  run: (ctx, input) => {
    const user = liveUser(ctx.db, input.id);
    const before = user.mfa;
    ctx.put('users', {
      ...user,
      mfa: { totp: false, passkeys: 0, recoveryCodesLeft: 0 }
    });
    ctx.db.passkeys = ctx.db.passkeys.filter(
      passkey => passkey.userId !== user.id
    );
    ctx.audit({
      entityKind: 'user',
      entityId: user.id,
      changes: [
        { field: 'mfa', from: before, to: null },
        { field: 'tokensRevoked', from: false, to: true }
      ],
      undoable: false
    });
    return { id: user.id };
  }
});

/* ---------------- forwarding ---------------- */

const conditionOrder = (rule: { condition: UserForwardCondition }): number =>
  USER_FORWARD_CONDITIONS.indexOf(rule.condition);

defineOp<{ id: string }, { id: string; rules: UserForwardRule[] }>({
  name: 'users.getForwarding',
  minRole: 'user',
  scope: ownUserId,
  readOnly: true,
  run: (ctx, input) => {
    liveUser(ctx.db, input.id);
    const rules = [...(ctx.db.userForwarding[input.id] ?? [])].sort(
      (a, b) => conditionOrder(a) - conditionOrder(b)
    );
    return { id: input.id, rules };
  }
});

/** `isSameAdminTarget`: the very admin target a condition already holds, `record` included. */
function isSameAdminTarget(
  stored: ForwardTarget,
  next: ForwardTarget
): boolean {
  if (!isAdminTarget(stored)) {
    return false;
  }
  if (stored.kind === 'external' && next.kind === 'external') {
    return stored.external === next.external && stored.record === next.record;
  }
  if (stored.kind !== 'sip' || next.kind !== 'sip') {
    return false;
  }
  return (
    stored.trunkId === next.trunkId &&
    stored.user === next.user &&
    JSON.stringify(
      stored.headers.map(header => [header.name, header.value])
    ) ===
      JSON.stringify(next.headers.map(header => [header.name, header.value])) &&
    stored.record === next.record
  );
}

defineOp<
  { id: string; rules: UserForwardRule[] },
  { id: string; rules: UserForwardRule[] }
>({
  name: 'users.setForwarding',
  minRole: 'user',
  scope: ownUserId,
  run: (ctx, input) => {
    liveUser(ctx.db, input.id);
    const seen = new Set<string>();
    for (const rule of input.rules) {
      if (
        !(USER_FORWARD_CONDITIONS as readonly string[]).includes(rule.condition)
      ) {
        throw invalid('rules', 'invalid', 'unknown condition', {
          message: rule.condition
        });
      }
      if (seen.has(rule.condition)) {
        throw invalid(
          'rules',
          'people.duplicateCondition',
          `users: duplicate forwarding condition '${rule.condition}'`,
          {
            condition: rule.condition
          }
        );
      }
      seen.add(rule.condition);
    }
    const existing = ctx.db.userForwarding[input.id] ?? [];
    const rules = input.rules.map(rule => {
      const stored = existing.find(each => each.condition === rule.condition);
      // A user keeps the very admin target the condition already holds, unchanged.
      if (
        ctx.actor.role === 'user' &&
        stored !== undefined &&
        isSameAdminTarget(stored.target, rule.target)
      ) {
        return { condition: rule.condition, target: stored.target };
      }
      assertMayHoldTarget(ctx, rule.target);
      return {
        condition: rule.condition,
        target: checkTarget(ctx.db, rule.target, `rules.${rule.condition}`)
      };
    });
    rules.sort((a, b) => conditionOrder(a) - conditionOrder(b));
    ctx.setKey('userForwarding', input.id, rules);
    ctx.audit({
      entityKind: 'user',
      entityId: input.id,
      changes: [{ field: 'rules', from: existing, to: rules }]
    });
    return { id: input.id, rules };
  }
});

/* ---------------- presence (not audited) ---------------- */

defineOp<{ id: string; dnd: boolean }, { id: string; dnd: boolean }>({
  name: 'users.setPresence',
  minRole: 'user',
  scope: ownUserId,
  run: (ctx, input) => {
    const user = liveUser(ctx.db, input.id);
    user.dnd = input.dnd;
    const current = ctx.db.presence[user.id];
    const registered = ctx.db.devices.some(
      device =>
        device.userId === user.id &&
        device.deletedAt === null &&
        device.lastRegisteredAt !== null
    );
    const status: PresenceStatus = input.dnd
      ? 'dnd'
      : current !== undefined && current.status !== 'dnd'
        ? current.status
        : registered
          ? 'available'
          : 'offline';
    if (user.extension !== null) {
      const entry = {
        userId: user.id,
        status,
        since: ctx.now,
        peer: null,
        ringGroupId: null
      };
      ctx.db.presence[user.id] = entry;
      ctx.db.presenceLog.push({ ...entry });
    }
    ctx.emit(
      {
        type: 'presence',
        userId: user.id,
        status,
        peer: null,
        ringGroupId: null
      },
      [user.id]
    );
    return { id: user.id, dnd: input.dnd };
  }
});

/* ---------------- personal voicemail greeting (not audited) ---------------- */

/** The label `*96` gives a recorded greeting (`_greeting.ts`). */
export const GREETING_LABEL = 'Mailbox greeting';

/** `retireGreeting`: soft-deletes a replaced personal greeting nothing else references. */
function retireGreeting(
  db: Db,
  audioId: string | null,
  userId: string,
  now: string
): void {
  if (audioId === null) {
    return;
  }
  const asset = db.audio.find(
    candidate =>
      candidate.id === audioId &&
      candidate.kind === 'vmGreeting' &&
      candidate.deletedAt === null
  );
  const referenced =
    db.users.some(
      user =>
        user.id !== userId &&
        user.deletedAt === null &&
        user.mailboxAudioId === audioId
    ) ||
    db.ringGroups.some(
      group => group.deletedAt === null && group.mailboxAudioId === audioId
    ) ||
    allTargets().some(
      ({ target }) =>
        target.kind === 'announcement' && target.audioId === audioId
    );
  if (asset !== undefined && !referenced) {
    asset.deletedAt = now;
  }
}

/** The mock's upload: the picked file's name and, when the browser could read it, its length. */
export type GreetingUpload = { filename: string; durationS?: number };

defineOp<
  { id: string; upload: GreetingUpload },
  { id: string; mailboxAudioId: string }
>({
  name: 'users.setVoicemailGreeting',
  minRole: 'user',
  scope: ownUserId,
  run: (ctx, input) => {
    const user = liveUser(ctx.db, input.id);
    if (!/\.(wav|mp3)$/iu.test(input.upload.filename)) {
      throw invalid(
        'upload',
        'people.greetingFormat',
        'the greeting must be a WAV or MP3 file',
        {
          name: input.upload.filename
        }
      );
    }
    const asset: AudioAsset = {
      id: newId(),
      kind: 'vmGreeting',
      label: GREETING_LABEL,
      durationS: Math.max(1, Math.round(input.upload.durationS ?? 9)),
      bundled: false,
      createdAt: ctx.now,
      deletedAt: null,
      clip: null
    };
    ctx.db.audio.push(asset);
    const previous = user.mailboxAudioId;
    user.mailboxAudioId = asset.id;
    retireGreeting(ctx.db, previous, user.id, ctx.now);
    return { id: user.id, mailboxAudioId: asset.id };
  }
});

defineOp<{ id: string }, { id: string; mailboxAudioId: null }>({
  name: 'users.clearVoicemailGreeting',
  minRole: 'user',
  scope: ownUserId,
  confirm: (ctx, input) => ({
    key: 'users.clearVoicemailGreeting',
    params: { name: liveUser(ctx.db, input.id).name },
    destructive: true
  }),
  run: (ctx, input) => {
    const user = liveUser(ctx.db, input.id);
    const previous = user.mailboxAudioId;
    user.mailboxAudioId = null;
    retireGreeting(ctx.db, previous, user.id, ctx.now);
    return { id: user.id, mailboxAudioId: null };
  }
});
