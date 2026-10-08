/**
 * The blocklist (`ops/blockedNumbers/`, admin): numbers or prefixes refused on inbound calls.
 * Create and delete only; `(number, isPrefix)` unique among live entries.
 */
import { conflict, notFound } from '../../errors';
import { newId } from '../../ids';
import type { BlockedNumber } from '../../types';
import { defineOp } from '../core';
import { requireE164 } from '../validate';

defineOp<Record<string, never>, { items: BlockedNumber[] }>({
  name: 'blockedNumbers.list',
  minRole: 'admin',
  readOnly: true,
  run: ctx => ({
    items: ctx.db.blockedNumbers.filter(row => row.deletedAt === null)
  })
});

defineOp<
  { number: string; isPrefix?: boolean; label?: string | null },
  BlockedNumber
>({
  name: 'blockedNumbers.create',
  minRole: 'admin',
  run: (ctx, input) => {
    const number = requireE164('number', input.number, ctx.db);
    const isPrefix = input.isPrefix ?? false;
    const clash = ctx.db.blockedNumbers.find(
      row =>
        row.deletedAt === null &&
        row.number === number &&
        row.isPrefix === isPrefix
    );
    if (clash !== undefined) {
      throw conflict('duplicate', 'blockedNumbers: already blocked', [
        { kind: 'blockedNumber', id: clash.id, label: clash.number }
      ]);
    }
    const row: BlockedNumber = {
      id: newId(),
      number,
      isPrefix,
      label: input.label?.trim() || null,
      createdAt: ctx.now,
      deletedAt: null
    };
    ctx.insert('blockedNumbers', row);
    ctx.audit({
      entityKind: 'blockedNumber',
      entityId: row.id,
      before: null,
      after: row
    });
    return row;
  }
});

defineOp<{ id: string }, { deleted: true }>({
  name: 'blockedNumbers.delete',
  minRole: 'admin',
  confirm: (ctx, input) => ({
    key: 'blockedNumbers.delete',
    params: {
      number:
        ctx.db.blockedNumbers.find(row => row.id === input.id)?.number ?? ''
    },
    destructive: true
  }),
  run: (ctx, input) => {
    const row = ctx.db.blockedNumbers.find(
      candidate => candidate.id === input.id && candidate.deletedAt === null
    );
    if (row === undefined) {
      throw notFound('blockedNumber', input.id);
    }
    const before = { ...row };
    ctx.softDelete('blockedNumbers', row.id);
    ctx.audit({
      entityKind: 'blockedNumber',
      entityId: row.id,
      before,
      after: { ...before, deletedAt: ctx.now }
    });
    return { deleted: true };
  }
});
