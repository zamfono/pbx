/**
 * Auto-attendant menus (`ops/menus/`, admin): a greeting (an `announcement` asset), a DTMF map of
 * key strings to targets (`menus.setTargets`), and a fallback after the last attempt. A delete is
 * refused while a target elsewhere dials the menu; its own fallback and options travel with it.
 */
import { ApiError, conflict, invalid, notFound } from '../../errors';
import { newId } from '../../ids';
import type { Db, ForwardTarget, Menu, MenuTarget } from '../../types';
import { defineOp } from '../core';
import {
  checkTarget,
  requireAudioOfKind,
  softDeleteConfirm,
  targetOwners
} from './ooo';

const MAX_TIMEOUT_S = 86_400;
const DEFAULT_TIMEOUT_S = 5;
const DEFAULT_MAX_ATTEMPTS = 3;

/** The key strings `menu_targets.digits` accepts: one or more of `0-9 * #`. */
export const DIGITS = /^[0-9*#]+$/u;

function liveMenu(db: Db, id: string): Menu {
  const menu = db.menus.find(row => row.id === id && row.deletedAt === null);
  if (menu === undefined) {
    throw notFound('menu', id);
  }
  return menu;
}

function requireName(db: Db, value: unknown, exceptId?: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw invalid('name', 'groups.required', 'name is required');
  }
  const name = value.trim();
  const clash = db.menus.find(
    row => row.deletedAt === null && row.name === name && row.id !== exceptId
  );
  if (clash !== undefined) {
    throw conflict('duplicate', 'menus: name already in use', [
      { kind: 'menu', id: clash.id, label: clash.name }
    ]);
  }
  return name;
}

function requireAudio(db: Db, value: unknown): string {
  if (typeof value !== 'string' || value === '') {
    throw invalid('audioId', 'groups.required', 'audioId is required');
  }
  requireAudioOfKind(db, 'audioId', value, 'announcement');
  return value;
}

function requirePositive(field: string, value: unknown, max?: number): number {
  if (
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    value < 1 ||
    (max !== undefined && value > max)
  ) {
    throw max === undefined
      ? invalid(field, 'groups.positive', `${field} must be a positive integer`)
      : invalid(field, 'groups.range', `${field} must be an integer 1–${max}`, {
          min: 1,
          max
        });
  }
  return value;
}

/** Ordered by digits as the database orders text (byte order: `#` < `*` < `0` … `9`). */
export const byDigits = (targets: MenuTarget[]): MenuTarget[] =>
  targets.toSorted((first, second) =>
    first.digits < second.digits ? -1 : first.digits > second.digits ? 1 : 0
  );

export type MenuInput = {
  name: string;
  audioId: string;
  timeoutS?: number;
  maxAttempts?: number;
  allowExtensionDialing?: boolean;
  fallbackTarget: ForwardTarget;
};

defineOp<Record<string, never>, { items: Menu[] }>({
  name: 'menus.list',
  minRole: 'admin',
  readOnly: true,
  run: ctx => ({
    items: ctx.db.menus
      .filter(row => row.deletedAt === null)
      .toSorted((first, second) => first.name.localeCompare(second.name))
  })
});

defineOp<{ id: string }, Menu>({
  name: 'menus.get',
  minRole: 'admin',
  readOnly: true,
  run: (ctx, input) => liveMenu(ctx.db, input.id)
});

defineOp<MenuInput, Menu>({
  name: 'menus.create',
  minRole: 'admin',
  run: (ctx, input) => {
    const db = ctx.db;
    const name = requireName(db, input.name);
    const audioId = requireAudio(db, input.audioId);
    if (input.fallbackTarget === undefined || input.fallbackTarget === null) {
      throw invalid(
        'fallbackTarget',
        'groups.required',
        'fallbackTarget is required'
      );
    }
    const row: Menu = {
      id: newId(),
      name,
      audioId,
      timeoutS:
        input.timeoutS === undefined
          ? DEFAULT_TIMEOUT_S
          : requirePositive('timeoutS', input.timeoutS, MAX_TIMEOUT_S),
      maxAttempts:
        input.maxAttempts === undefined
          ? DEFAULT_MAX_ATTEMPTS
          : requirePositive('maxAttempts', input.maxAttempts),
      allowExtensionDialing: input.allowExtensionDialing ?? false,
      fallbackTarget: checkTarget(ctx, 'fallbackTarget', input.fallbackTarget),
      targets: [],
      createdAt: ctx.now,
      deletedAt: null
    };
    ctx.insert('menus', row);
    ctx.audit({
      entityKind: 'menu',
      entityId: row.id,
      before: null,
      after: row
    });
    return row;
  }
});

defineOp<{ id: string } & Partial<MenuInput>, Menu>({
  name: 'menus.update',
  minRole: 'admin',
  run: (ctx, input) => {
    const db = ctx.db;
    const before = liveMenu(db, input.id);
    const next: Menu = {
      ...before,
      name:
        input.name === undefined || input.name === before.name
          ? before.name
          : requireName(db, input.name, before.id),
      audioId:
        input.audioId === undefined
          ? before.audioId
          : requireAudio(db, input.audioId),
      timeoutS:
        input.timeoutS === undefined
          ? before.timeoutS
          : requirePositive('timeoutS', input.timeoutS, MAX_TIMEOUT_S),
      maxAttempts:
        input.maxAttempts === undefined
          ? before.maxAttempts
          : requirePositive('maxAttempts', input.maxAttempts),
      allowExtensionDialing:
        input.allowExtensionDialing ?? before.allowExtensionDialing,
      fallbackTarget:
        input.fallbackTarget === undefined
          ? before.fallbackTarget
          : checkTarget(ctx, 'fallbackTarget', input.fallbackTarget)
    };
    const previous = { ...before };
    ctx.put('menus', next);
    ctx.audit({
      entityKind: 'menu',
      entityId: next.id,
      before: previous,
      after: next
    });
    return next;
  }
});

/** Where menu `id` is still dialled, outside its own fallback and options (`findMenuReferences`). */
export const menuReferences = (db: Db, id: string) =>
  targetOwners(db, target => target.kind === 'menu' && target.menuId === id, {
    menuId: id
  });

defineOp<{ id: string }, { id: string }>({
  name: 'menus.delete',
  minRole: 'admin',
  confirm: (ctx, input) =>
    softDeleteConfirm(ctx, 'menus.delete', {
      name: liveMenu(ctx.db, input.id).name
    }),
  run: (ctx, input) => {
    const menu = liveMenu(ctx.db, input.id);
    const refs = menuReferences(ctx.db, menu.id);
    if (refs.length > 0) {
      throw conflict('inUse', 'menu is still in use', refs);
    }
    const before = { ...menu };
    ctx.softDelete('menus', menu.id);
    ctx.audit({
      entityKind: 'menu',
      entityId: menu.id,
      before,
      after: { ...before, deletedAt: ctx.now }
    });
    return { id: menu.id };
  }
});

defineOp<{ id: string }, { id: string; targets: MenuTarget[] }>({
  name: 'menus.getTargets',
  minRole: 'admin',
  readOnly: true,
  run: (ctx, input) => ({
    id: input.id,
    targets: byDigits(liveMenu(ctx.db, input.id).targets)
  })
});

defineOp<
  { id: string; targets: MenuTarget[] },
  { id: string; targets: MenuTarget[] }
>({
  name: 'menus.setTargets',
  minRole: 'admin',
  run: (ctx, input) => {
    const menu = liveMenu(ctx.db, input.id);
    const seen = new Set<string>();
    for (const option of input.targets) {
      if (typeof option.digits !== 'string' || !DIGITS.test(option.digits)) {
        throw invalid(
          'targets',
          'groups.digits',
          `digits '${option.digits}' must be one or more of 0-9 * #`,
          { digits: String(option.digits) }
        );
      }
      if (seen.has(option.digits)) {
        throw new ApiError(
          422,
          'groups.duplicateDigits',
          `menus: duplicate target digits '${option.digits}'`,
          {
            field: 'targets',
            params: { digits: option.digits }
          }
        );
      }
      seen.add(option.digits);
    }
    const targets = byDigits(
      input.targets.map(option => ({
        digits: option.digits,
        target: checkTarget(ctx, 'targets', option.target)
      }))
    );
    const before = { ...menu };
    const next: Menu = { ...menu, targets };
    ctx.put('menus', next);
    ctx.audit({
      entityKind: 'menu',
      entityId: menu.id,
      before: { targets: before.targets },
      after: { targets }
    });
    return { id: menu.id, targets };
  }
});
