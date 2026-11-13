import { HTTP_FORBIDDEN, HTTP_UNPROCESSABLE_CONTENT } from '@zamfono/shared';

import { findForwardTargetOwners } from './forwardTargetOwners.js';
import type {
  ManagedTarget,
  OwnTarget,
  TargetSpec
} from './forwardTargetSchema.js';
import { insertForwardTarget } from './forwardTargetSpec.js';
import { OpError, type Context } from './types.js';

/**
 * Whether only an `admin` or `owner` sets or keeps `target` (§10.3 "Forward targets"): a `sip`
 * target, which sends calls to whatever host its trunk names (§9.4 "SIP targets"), a `webSocket`
 * one, which sends a call's audio to whatever URL it names (§9.4 "WebSocket targets"), and an
 * `external` one that records (§10.2 "Recording semantics").
 */
export function isAdminTarget(target: TargetSpec): boolean {
  return (
    target.kind === 'sip' ||
    target.kind === 'webSocket' ||
    (target.kind === 'external' && target.record)
  );
}

/** `target` and each fallback down its chain, in order (§10.1 step 7). */
export function targetChain(target: TargetSpec): TargetSpec[] {
  const fallback = ('fallback' in target ? target.fallback : null) ?? null;
  return fallback === null ? [target] : [target, ...targetChain(fallback)];
}

/** Why a `user` may not set the admin target `target` (`createTarget`, `resolveOwnTarget`). */
function adminTargetRefusal(target: TargetSpec): string {
  if (target.kind === 'sip') {
    return 'a sip target is set by an admin';
  }
  if (target.kind === 'webSocket') {
    return 'a webSocket target is set by an admin';
  }
  return 'a recording target is set by an admin';
}

/** Whether `target` holds an admin target (`isAdminTarget`) anywhere in its fallback chain, so
 * that a `user` reads it masked and keeps it only by sending the marker back (§10.3). */
export function isManagedTarget(target: TargetSpec): boolean {
  return targetChain(target).some(isAdminTarget);
}

/**
 * §10.3 "Forward targets": `target` as `ctx`'s actor reads it in their own forwarding, OOO rules
 * or opening hours, an admin-set one (`isManagedTarget`) as the marker `{ managed: true, kind }`
 * for a `user`, so that neither a bot's URL with its token nor a header value reaches them;
 * admins and owners read it in full.
 */
export function readableTarget(ctx: Context, target: TargetSpec): OwnTarget {
  if (ctx.actor.role !== 'user' || !isManagedTarget(target)) {
    return target;
  }
  // Only these kinds carry a fallback, so only they head a chain holding an admin target.
  return { managed: true, kind: target.kind as ManagedTarget['kind'] };
}

/** A target as one place holds it: its own `forward_targets` row and what the row represents. */
export type HeldTarget = { targetId: string; target: TargetSpec };

/**
 * §10.3 "Forward targets": what one place (a forwarding rule's condition, an OOO rule, a scope's
 * closed hours) is to hold, given `input` for it and `held`, what it holds now. The marker keeps
 * `held` as it is, its own row and all, where `held` is an admin-set target of the marker's kind,
 * and is refused with 422 elsewhere; matched by place alone, so a marker moved to another
 * condition keeps nothing. A `user`'s full admin target where one is held is refused with 422
 * naming the marker to send back; any other target comes back with a `null` row, for the caller
 * to write through `createTarget`, which refuses a `user` an admin target with 403.
 */
export function resolveOwnTarget(
  ctx: Context,
  input: OwnTarget,
  held: HeldTarget | undefined
): { targetId: string | null; target: TargetSpec } {
  const managed = held !== undefined && isManagedTarget(held.target);
  if ('managed' in input) {
    if (!managed || held.target.kind !== input.kind) {
      throw new OpError(
        HTTP_UNPROCESSABLE_CONTENT,
        `no ${input.kind} target set by an admin is held here to keep; read the target again`
      );
    }
    return held;
  }
  const admin = targetChain(input).find(isAdminTarget);
  if (ctx.actor.role === 'user' && managed && admin !== undefined) {
    throw new OpError(
      HTTP_UNPROCESSABLE_CONTENT,
      `${adminTargetRefusal(admin)}: to keep the one held here, send back the marker read in its place, { "managed": true, "kind": "${held.target.kind}" }`
    );
  }
  return { targetId: null, target: input };
}

/**
 * Inserts a `forward_targets` row for `input`, owned by the caller's rule, and returns its id;
 * 403s for an admin target (`isAdminTarget`), anywhere in its fallback chain, from a `user`
 * (§10.3 "Forward targets"), which every operation a `user` may call writes its targets through,
 * and 404s when `input` points at a row that is not live (§5.9).
 */
export async function createTarget(
  ctx: Context,
  input: TargetSpec
): Promise<string> {
  const admin = targetChain(input).find(isAdminTarget);
  if (ctx.actor.role === 'user' && admin !== undefined) {
    throw new OpError(HTTP_FORBIDDEN, adminTargetRefusal(admin));
  }
  return insertForwardTarget(ctx, input);
}

/**
 * Deletes a `forward_targets` row once no owner column references it any more (§5.9, §11.2): the
 * caller deletes its own owning row first, so this only ever finds a reference genuinely left by
 * another entity.
 */
export async function deleteTargetIfOrphan(
  ctx: Context,
  id: string
): Promise<void> {
  const owners = await findForwardTargetOwners(ctx.db, [id]);
  if (owners.length === 0) {
    await ctx.db.deleteFrom('forwardTargets').where('id', '=', id).execute();
  }
}
