/**
 * The SIP ban allowlist (`ops/sipAllowlist/`, §5.6): source addresses and ranges never banned for
 * failed SIP attempts. Adding one ends every active ban it covers.
 */
import { conflict, invalid, notFound } from '../../errors';
import { newId } from '../../ids';
import type { SipAllowlistEntry } from '../../types';
import { defineOp } from '../core';
import { isIpOrCidr } from '../validate';
import { isActiveBan } from './sipBans';

export type SipAllowlistEntryWire = Omit<SipAllowlistEntry, 'deletedAt'>;

const toWire = ({
  deletedAt: _deleted,
  ...entry
}: SipAllowlistEntry): SipAllowlistEntryWire => entry;

/** An IPv4 address or range as [first, last]; null for IPv6. */
function ipv4Range(value: string): [number, number] | null {
  const [address = '', prefix] = value.split('/');
  const octets = address.split('.').map(Number);
  if (octets.length !== 4 || octets.some(octet => !Number.isInteger(octet))) {
    return null;
  }
  const base = octets.reduce((sum, octet) => sum * 256 + octet, 0);
  const bits = prefix === undefined ? 32 : Number(prefix);
  const size = 2 ** (32 - bits);
  const first = Math.floor(base / size) * size;
  return [first, first + size - 1];
}

/** Whether two addresses or ranges overlap (`addressRangesOverlap`). */
export function rangesOverlap(a: string, b: string): boolean {
  const left = ipv4Range(a);
  const right = ipv4Range(b);
  if (left === null || right === null) {
    return a.toLowerCase() === b.toLowerCase();
  }
  return left[0] <= right[1] && right[0] <= left[1];
}

function liveEntry(
  entries: SipAllowlistEntry[],
  id: string
): SipAllowlistEntry {
  const row = entries.find(
    candidate => candidate.id === id && candidate.deletedAt === null
  );
  if (row === undefined) {
    throw notFound('sipAllowlistEntry', id);
  }
  return row;
}

defineOp<
  { limit?: number; cursor?: string },
  { items: SipAllowlistEntryWire[]; nextCursor: null }
>({
  name: 'sipAllowlist.list',
  minRole: 'admin',
  readOnly: true,
  run: ctx => ({
    items: ctx.db.sipAllowlist
      .filter(row => row.deletedAt === null)
      .map(toWire),
    nextCursor: null
  })
});

defineOp<{ address: string; label?: string | null }, SipAllowlistEntryWire>({
  name: 'sipAllowlist.create',
  minRole: 'admin',
  run: (ctx, input) => {
    const address = (input.address ?? '').trim();
    if (!isIpOrCidr(address)) {
      throw invalid(
        'address',
        'sipAllowlistAddress',
        'address must be an IP address or a CIDR range',
        { value: address }
      );
    }
    const clash = ctx.db.sipAllowlist.find(
      row =>
        row.deletedAt === null &&
        row.address.toLowerCase() === address.toLowerCase()
    );
    if (clash !== undefined) {
      throw conflict('duplicate', 'sipAllowlist: already listed', [
        { kind: 'sipAllowlistEntry', id: clash.id, label: clash.address }
      ]);
    }
    const row: SipAllowlistEntry = {
      id: newId(),
      address,
      label: input.label?.trim() || null,
      createdAt: ctx.now,
      deletedAt: null
    };
    ctx.insert('sipAllowlist', row);
    ctx.audit({
      entityKind: 'sipAllowlistEntry',
      entityId: row.id,
      before: null,
      after: row
    });
    for (const ban of ctx.db.sipBans) {
      if (isActiveBan(ban, ctx.now) && rangesOverlap(address, ban.address)) {
        Object.assign(ban, { liftedAt: ctx.now, liftedBy: ctx.actor.id });
      }
    }
    return toWire(row);
  }
});

defineOp<{ id: string }, { id: string }>({
  name: 'sipAllowlist.delete',
  minRole: 'admin',
  confirm: (ctx, input) => ({
    key: 'sipAllowlist.delete',
    params: { address: liveEntry(ctx.db.sipAllowlist, input.id).address },
    destructive: true
  }),
  run: (ctx, input) => {
    const before = { ...liveEntry(ctx.db.sipAllowlist, input.id) };
    ctx.softDelete('sipAllowlist', before.id);
    ctx.audit({
      entityKind: 'sipAllowlistEntry',
      entityId: before.id,
      before,
      after: { ...before, deletedAt: ctx.now }
    });
    return { id: before.id };
  }
});
