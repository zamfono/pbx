/**
 * SIP bans (`ops/sipBans/`, §5.6): sources of failed SIP attempts the stack drops. A ban is in force
 * until it expires or an admin lifts it; lifting is a security action without undo.
 */
import { conflict, notFound } from '../../errors';
import type { SipBan } from '../../types';
import { defineOp } from '../core';

export type SipBanState = 'active' | 'ended' | 'all';
export type SipBanWire = Omit<SipBan, 'reason'> & { liftedBy: string | null };

type StoredBan = SipBan & { liftedBy?: string | null };

/** Whether `ban` is in force at `now`. */
export const isActiveBan = (ban: SipBan, now: string): boolean =>
  ban.liftedAt === null && (ban.expiresAt === null || ban.expiresAt > now);

const toWire = ({
  reason: _reason,
  liftedBy,
  ...ban
}: StoredBan): SipBanWire => ({ ...ban, liftedBy: liftedBy ?? null });

defineOp<
  { state?: SipBanState; limit?: number; cursor?: string },
  { items: SipBanWire[]; nextCursor: null }
>({
  name: 'sipBans.list',
  minRole: 'admin',
  readOnly: true,
  run: (ctx, input) => {
    const state = input.state ?? 'active';
    return {
      items: ctx.db.sipBans
        .filter(
          ban =>
            state === 'all' ||
            isActiveBan(ban, ctx.now) === (state === 'active')
        )
        .toSorted((a, b) => b.createdAt.localeCompare(a.createdAt))
        .map(toWire),
      nextCursor: null
    };
  }
});

defineOp<{ id: string }, { id: string }>({
  name: 'sipBans.lift',
  minRole: 'admin',
  confirm: (ctx, input) => {
    const ban = ctx.db.sipBans.find(row => row.id === input.id);
    if (ban === undefined) {
      throw notFound('sipBan', input.id);
    }
    return {
      key: 'sipBans.lift',
      params: { address: ban.address },
      destructive: true,
      irreversible: true
    };
  },
  run: (ctx, input) => {
    const ban = ctx.db.sipBans.find(row => row.id === input.id) as
      StoredBan | undefined;
    if (ban === undefined) {
      throw notFound('sipBan', input.id);
    }
    if (!isActiveBan(ban, ctx.now)) {
      throw conflict('sipBanEnded', 'sipBans: the ban has already ended');
    }
    ban.liftedAt = ctx.now;
    ban.liftedBy = ctx.actor.id;
    ctx.audit({
      entityKind: 'sipBan',
      entityId: ban.id,
      changes: [{ field: 'liftedAt', from: null, to: ctx.now }],
      undoable: false
    });
    return { id: ban.id };
  }
});
