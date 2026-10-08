/**
 * Numbers (`ops/dids/`, admin): the phone numbers the tenant owns and where their calls go
 * (§10.3 "Extensions & DIDs", §11.3). A number is fixed at creation, its target editable; the main
 * number and a number presented as caller ID cannot be deleted. Also the forward-target checks the
 * numbers and number blocks share (`forwardTargetSpec.ts`'s `assertTargetAvailable`).
 */
import { conflict, invalid, notFound, type BlockingRef } from '../../errors';
import { newId } from '../../ids';
import type { Db, Did, ForwardTarget, User } from '../../types';
import { defineOp, diff, type ConfirmInfo, type Ctx } from '../core';

/** A number the trunk boundary produced in the international form, `+` and digits (`isE164`). */
export const isNumericNumber = (value: string): boolean =>
  /^\+[0-9]+$/u.test(value);

/** Digits with an optional leading `+`: what the boundary normalises (`isInboundNumber`). */
const DIGITS_WITH_OPTIONAL_PLUS = /^\+?[0-9]+$/u;

/** International and trunk prefixes of the countries the mock normalises national numbers for. */
const NUMBERING: Record<string, { code: string; idd: string; trunk: string }> =
  {
    DE: { code: '49', idd: '00', trunk: '0' },
    AT: { code: '43', idd: '00', trunk: '0' },
    CH: { code: '41', idd: '00', trunk: '0' },
    FR: { code: '33', idd: '00', trunk: '0' },
    GB: { code: '44', idd: '00', trunk: '0' },
    NL: { code: '31', idd: '00', trunk: '0' },
    IT: { code: '39', idd: '00', trunk: '' }
  };

/** The fewest national digits the mock reads as a number rather than a short string. */
const MIN_NATIONAL_DIGITS = 5;

/**
 * `raw` as `dids.create` and `didBlocks.create` store it (`normalizeInbound(raw, 'national',
 * country)`): a national number of the tenant's country, or one dialled with its international
 * prefix, in the international form; anything that is not digits with an optional `+`, such as a
 * provider's account name, verbatim.
 */
export function normaliseInbound(db: Db, raw: string): string {
  if (!DIGITS_WITH_OPTIONAL_PLUS.test(raw) || raw.startsWith('+')) {
    return raw;
  }
  const plan = NUMBERING[db.settings.country];
  if (plan === undefined) {
    return raw;
  }
  if (raw.startsWith(plan.idd)) {
    return `+${raw.slice(plan.idd.length)}`;
  }
  // libphonenumber accepts only a valid number; the mock asks for a plausible length instead.
  const national = raw.startsWith(plan.trunk)
    ? raw.slice(plan.trunk.length)
    : null;
  if (national === null || national.length < MIN_NATIONAL_DIGITS) {
    return raw;
  }
  return `+${plan.code}${plan.trunk === '' ? raw : national}`;
}

/**
 * A number or number prefix as people type it, for a form that sends E.164 (an outbound route's
 * numbers): spaces and separators dropped, the international prefix as `+`, a national number's
 * trunk prefix as the country's calling code. Anything else is left for the operation to refuse.
 */
export function typedToE164(db: Db, typed: string): string {
  const compact = typed.replace(/[\s()/.-]/gu, '');
  const plan = NUMBERING[db.settings.country];
  if (compact.startsWith('+') || plan === undefined) {
    return compact;
  }
  if (compact.startsWith(plan.idd)) {
    return `+${compact.slice(plan.idd.length)}`;
  }
  if (plan.trunk !== '' && compact.startsWith(plan.trunk)) {
    return `+${plan.code}${compact.slice(plan.trunk.length)}`;
  }
  return compact;
}

/** A called number or block base: non-empty and free of whitespace (§11.3). */
export function requireCalledNumber(field: string, value: unknown): string {
  if (typeof value !== 'string' || value === '') {
    throw invalid(field, 'numbers.numberRequired', `${field} is required`);
  }
  if (/\s/u.test(value)) {
    throw invalid(field, 'numbers.numberWhitespace', `${field}: no whitespace`);
  }
  return value;
}

const SIP_USER_PATTERN = /^[A-Za-z0-9._~+-]{1,64}$/u;

const isLive = <T extends { id: string; deletedAt: string | null }>(
  rows: T[],
  id: string
): boolean => rows.some(row => row.id === id && row.deletedAt === null);

/**
 * Refuses a forward target the API's `targetSpecSchema` (422) or `assertTargetAvailable` (404)
 * refuses: an `external` number that is not E.164, a `sip` user outside `A-Z a-z 0-9 . _ ~ + -`,
 * or a reference to a row that is not live.
 */
export function assertTarget(
  db: Db,
  field: string,
  target: ForwardTarget
): void {
  switch (target.kind) {
    case 'external':
      if (!isNumericNumber(target.external)) {
        throw invalid(
          field,
          'numbers.targetExternal',
          'external must be E.164',
          { value: target.external }
        );
      }
      return;
    case 'sip':
      if (!SIP_USER_PATTERN.test(target.user)) {
        throw invalid(
          field,
          'numbers.targetSipUser',
          'user must be 1-64 of A-Z a-z 0-9 . _ ~ + -'
        );
      }
      if (!isLive(db.trunks, target.trunkId)) {
        throw notFound('trunk', target.trunkId);
      }
      return;
    case 'user':
    case 'mailboxUser':
      if (!isLive(db.users, target.userId)) {
        throw notFound('user', target.userId);
      }
      return;
    case 'ringGroup':
    case 'mailboxRingGroup':
      if (!isLive(db.ringGroups, target.ringGroupId)) {
        throw notFound('ringGroup', target.ringGroupId);
      }
      return;
    case 'announcement':
      if (
        !db.audio.some(
          asset =>
            asset.id === target.audioId &&
            asset.deletedAt === null &&
            asset.kind === 'announcement'
        )
      ) {
        throw notFound('audio', target.audioId);
      }
      return;
    case 'menu':
      if (!isLive(db.menus, target.menuId)) {
        throw notFound('menu', target.menuId);
      }
      return;
  }
}

/**
 * The confirmation of a soft delete (`softDeleteQuestion`): `<key>` while deletions are kept for
 * `softDeleteRetentionDays` days, `<key>.anyTime` while they are kept indefinitely.
 */
export function softDeleteConfirm(
  db: Db,
  key: string,
  params: Record<string, string | number>
): ConfirmInfo {
  const days = db.settings.softDeleteRetentionDays;
  return days === null
    ? { key: `${key}.anyTime`, params, destructive: true }
    : { key, params: { ...params, days }, destructive: true };
}

/**
 * Gives the target user of a numeric DID that DID as caller ID when they present none yet
 * (`setCallerIdIfUnset`, §9.4 "Caller-ID"); the change joins the DID's own audit entry.
 */
function setCallerIdIfUnset(
  ctx: Ctx,
  target: ForwardTarget,
  did: Did
): { field: string; from: unknown; to: unknown }[] {
  if (target.kind !== 'user' || !isNumericNumber(did.number)) {
    return [];
  }
  const user = ctx.db.users.find(
    row => row.id === target.userId && row.deletedAt === null
  );
  if (user === undefined || user.callerIdDidId !== null) {
    return [];
  }
  ctx.put<User>('users', { ...user, callerIdDidId: did.id });
  return [{ field: 'callerIdDidId', from: null, to: did.id }];
}

const liveDid = (db: Db, id: string): Did => {
  const row = db.dids.find(
    candidate => candidate.id === id && candidate.deletedAt === null
  );
  if (row === undefined) {
    throw notFound('did', id);
  }
  return row;
};

defineOp<Record<string, never>, { items: Did[] }>({
  name: 'dids.list',
  minRole: 'admin',
  readOnly: true,
  run: ctx => ({
    items: ctx.db.dids
      .filter(row => row.deletedAt === null)
      .sort((a, b) => a.id.localeCompare(b.id))
  })
});

defineOp<{ number: string; label?: string | null; target: ForwardTarget }, Did>(
  {
    name: 'dids.create',
    minRole: 'admin',
    run: (ctx, input) => {
      const number = normaliseInbound(
        ctx.db,
        requireCalledNumber('number', input.number)
      );
      const clash = ctx.db.dids.find(
        row => row.deletedAt === null && row.number === number
      );
      if (clash !== undefined) {
        throw conflict('numbers.numberTaken', 'dids: number already in use', [
          { kind: 'did', id: clash.id, label: clash.number }
        ]);
      }
      assertTarget(ctx.db, 'target', input.target);
      const row: Did = {
        id: newId(),
        number,
        label: input.label ?? null,
        target: input.target,
        createdAt: ctx.now,
        deletedAt: null
      };
      ctx.insert('dids', row);
      const callerId = setCallerIdIfUnset(ctx, input.target, row);
      ctx.audit({
        entityKind: 'did',
        entityId: row.id,
        changes: [...diff(null, row), ...callerId]
      });
      return row;
    }
  }
);

defineOp<{ id: string; target: ForwardTarget }, Did>({
  name: 'dids.update',
  minRole: 'admin',
  run: (ctx, input) => {
    const before = liveDid(ctx.db, input.id);
    assertTarget(ctx.db, 'target', input.target);
    const row: Did = { ...before, target: input.target };
    ctx.put('dids', row);
    const callerId = setCallerIdIfUnset(ctx, input.target, row);
    ctx.audit({
      entityKind: 'did',
      entityId: row.id,
      changes: [
        { field: 'target', from: before.target, to: input.target },
        ...callerId
      ]
    });
    return row;
  }
});

/** What still presents DID `id` (§5.9, §9.4 "Caller-ID"): the main number, users, routes. */
function deleteBlockers(
  db: Db,
  id: string
): { code: string; message: string; refs: BlockingRef[] } | null {
  if (db.settings.mainDidId === id) {
    return {
      code: 'numbers.mainNumber',
      message: 'dids: is the tenant main number',
      refs: [
        { kind: 'settings', id: 'settings', label: db.settings.companyName }
      ]
    };
  }
  const users = db.users.filter(
    user => user.deletedAt === null && user.callerIdDidId === id
  );
  if (users.length > 0) {
    return {
      code: 'numbers.callerIdOfUsers',
      message: 'dids: presented as caller-ID by users',
      refs: users.map(user => ({ kind: 'user', id: user.id, label: user.name }))
    };
  }
  const routes = db.outboundRoutes
    .map((route, index) => ({ route, index }))
    .filter(({ route }) => route.callerIdDidId === id);
  if (routes.length > 0) {
    return {
      code: 'numbers.callerIdOfRoutes',
      message: 'dids: presented as caller-ID by outbound routes',
      refs: routes.map(({ route, index }) => ({
        kind: 'outboundRoute',
        id: route.id,
        label: `#${index + 1} · ${db.trunks.find(trunk => trunk.id === route.trunkId)?.name ?? route.trunkId}`
      }))
    };
  }
  return null;
}

defineOp<{ id: string }, { id: string }>({
  name: 'dids.delete',
  minRole: 'admin',
  confirm: (ctx, input) =>
    softDeleteConfirm(ctx.db, 'dids.delete', {
      number: liveDid(ctx.db, input.id).number
    }),
  run: (ctx, input) => {
    const row = liveDid(ctx.db, input.id);
    const blocker = deleteBlockers(ctx.db, row.id);
    if (blocker !== null) {
      throw conflict(blocker.code, blocker.message, blocker.refs);
    }
    const before = { ...row };
    ctx.softDelete('dids', row.id);
    ctx.audit({
      entityKind: 'did',
      entityId: row.id,
      before,
      after: { ...before, deletedAt: ctx.now }
    });
    return { id: row.id };
  }
});
