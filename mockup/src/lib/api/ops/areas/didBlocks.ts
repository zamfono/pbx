/**
 * Number blocks (`ops/didBlocks/`, admin, §11.3): a base with a fixed digit count or open-ended. A
 * block groups the DIDs whose number falls inside it and gives its unassigned numbers a fallback;
 * the base is immutable, and a block cannot be deleted while a live DID falls inside it.
 */
import { conflict, invalid, notFound } from '../../errors';
import { newId } from '../../ids';
import type { Db, Did, DidBlock, ForwardTarget } from '../../types';
import { defineOp, diff } from '../core';
import {
  assertTarget,
  normaliseInbound,
  requireCalledNumber,
  softDeleteConfirm
} from './dids';

/** GLOB wildcards, which would widen the `did_blocks` soft-delete guard's `number GLOB base || '*'`. */
const GLOB_METACHARACTERS = ['*', '?', '[', ']'];

/** Whether DID number `number` falls inside `block` (`liveDidsInBlock`). */
export function inBlock(
  block: Pick<DidBlock, 'base' | 'digits'>,
  number: string
): boolean {
  return (
    number.startsWith(block.base) &&
    (block.digits === null ||
      number.length === block.base.length + block.digits)
  );
}

/** Live DIDs inside `block`. */
export function liveDidsInBlock(
  db: Db,
  block: Pick<DidBlock, 'base' | 'digits'>
): Did[] {
  return db.dids.filter(
    did => did.deletedAt === null && inBlock(block, did.number)
  );
}

function requireDigits(value: unknown): number | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw invalid(
      'digits',
      'numbers.digitsRange',
      'digits must be a positive integer'
    );
  }
  return value;
}

const liveBlock = (db: Db, id: string): DidBlock => {
  const row = db.didBlocks.find(
    candidate => candidate.id === id && candidate.deletedAt === null
  );
  if (row === undefined) {
    throw notFound('didBlock', id);
  }
  return row;
};

defineOp<Record<string, never>, { items: DidBlock[] }>({
  name: 'didBlocks.list',
  minRole: 'admin',
  readOnly: true,
  run: ctx => ({
    items: ctx.db.didBlocks
      .filter(row => row.deletedAt === null)
      .sort((a, b) => a.id.localeCompare(b.id))
  })
});

defineOp<
  {
    base: string;
    label?: string | null;
    digits?: number | null;
    fallbackTarget?: ForwardTarget | null;
  },
  DidBlock
>({
  name: 'didBlocks.create',
  minRole: 'admin',
  run: (ctx, input) => {
    const raw = requireCalledNumber('base', input.base);
    if (GLOB_METACHARACTERS.some(character => raw.includes(character))) {
      throw invalid(
        'base',
        'numbers.baseWildcard',
        'base: no GLOB metacharacter'
      );
    }
    const base = normaliseInbound(ctx.db, raw);
    const clash = ctx.db.didBlocks.find(
      row => row.deletedAt === null && row.base === base
    );
    if (clash !== undefined) {
      throw conflict('numbers.baseTaken', 'didBlocks: base already in use', [
        { kind: 'didBlock', id: clash.id, label: clash.label ?? clash.base }
      ]);
    }
    const digits = requireDigits(input.digits);
    const fallbackTarget = input.fallbackTarget ?? null;
    if (fallbackTarget !== null) {
      assertTarget(ctx.db, 'fallbackTarget', fallbackTarget);
    }
    const row: DidBlock = {
      id: newId(),
      base,
      label: input.label ?? null,
      digits,
      fallbackTarget,
      createdAt: ctx.now,
      deletedAt: null
    };
    ctx.insert('didBlocks', row);
    ctx.audit({
      entityKind: 'didBlock',
      entityId: row.id,
      changes: diff(null, row)
    });
    return row;
  }
});

defineOp<
  {
    id: string;
    label?: string | null;
    digits?: number | null;
    fallbackTarget?: ForwardTarget | null;
  },
  DidBlock
>({
  name: 'didBlocks.update',
  minRole: 'admin',
  run: (ctx, input) => {
    const before = liveBlock(ctx.db, input.id);
    const fallbackTarget =
      input.fallbackTarget === undefined
        ? before.fallbackTarget
        : input.fallbackTarget;
    if (input.fallbackTarget !== undefined && input.fallbackTarget !== null) {
      assertTarget(ctx.db, 'fallbackTarget', input.fallbackTarget);
    }
    const row: DidBlock = {
      ...before,
      label: input.label === undefined ? before.label : input.label,
      digits:
        input.digits === undefined
          ? before.digits
          : requireDigits(input.digits),
      fallbackTarget
    };
    ctx.put('didBlocks', row);
    ctx.audit({ entityKind: 'didBlock', entityId: row.id, before, after: row });
    return row;
  }
});

defineOp<{ id: string }, { id: string }>({
  name: 'didBlocks.delete',
  minRole: 'admin',
  confirm: (ctx, input) =>
    softDeleteConfirm(ctx.db, 'didBlocks.delete', {
      base: liveBlock(ctx.db, input.id).base
    }),
  run: (ctx, input) => {
    const block = liveBlock(ctx.db, input.id);
    const inside = liveDidsInBlock(ctx.db, block);
    if (inside.length > 0) {
      throw conflict(
        'numbers.blockHasNumbers',
        'didBlocks: live DIDs within the block',
        inside.map(did => ({ kind: 'did', id: did.id, label: did.number }))
      );
    }
    const before = { ...block };
    ctx.softDelete('didBlocks', block.id);
    ctx.audit({
      entityKind: 'didBlock',
      entityId: block.id,
      before,
      after: { ...before, deletedAt: ctx.now }
    });
    return { id: block.id };
  }
});
