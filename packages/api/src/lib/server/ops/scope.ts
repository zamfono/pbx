import { z } from 'zod';

import { HTTP_FORBIDDEN, HTTP_NOT_FOUND } from '@zamfono/shared';

import { isSelfOrAdmin } from './gates.js';
import { OpError, type Actor } from './types.js';

/**
 * The wire shape of an `ooo_rules`/`opening_hours` scope (§11.2): the path a `GET/POST
 * /users/{id}/ooo`-style route resolves to before calling the operation. `tenant` carries no id,
 * since all three scope columns are NULL for it.
 */
export const scopeInputSchema = z
  .discriminatedUnion('kind', [
    z.object({ kind: z.literal('tenant') }),
    z.object({ kind: z.literal('user'), id: z.string() }),
    z.object({ kind: z.literal('ringGroup'), id: z.string() }),
    z.object({ kind: z.literal('menu'), id: z.string() })
  ])
  .describe(
    "Whose it is: the tenant, or a user, ring group or menu by id; a call's target uses its own, else the tenant's."
  );

export type ScopeInput = z.infer<typeof scopeInputSchema>;

export type ScopeColumns = {
  scopeUserId: string | null;
  scopeRingGroupId: string | null;
  scopeMenuId: string | null;
};

/** The exclusive-arc scope columns (§11.1 "References") `scope` resolves to for an insert. */
export function scopeColumns(scope: ScopeInput): ScopeColumns {
  return {
    scopeUserId: scope.kind === 'user' ? scope.id : null,
    scopeRingGroupId: scope.kind === 'ringGroup' ? scope.id : null,
    scopeMenuId: scope.kind === 'menu' ? scope.id : null
  };
}

/** The inverse of `scopeColumns`: a row's scope columns back to the wire `ScopeInput`. */
export function scopeFromColumns(row: ScopeColumns): ScopeInput {
  if (row.scopeUserId !== null) {
    return { kind: 'user', id: row.scopeUserId };
  }
  if (row.scopeRingGroupId !== null) {
    return { kind: 'ringGroup', id: row.scopeRingGroupId };
  }
  if (row.scopeMenuId !== null) {
    return { kind: 'menu', id: row.scopeMenuId };
  }
  return { kind: 'tenant' };
}

/** Whether `actor` may act on `scope`: a `user` only their own user scope, `admin`/`owner` any. */
function ownsScope(actor: Actor, scope: ScopeInput): boolean {
  return isSelfOrAdmin(actor, scope.kind === 'user' ? scope.id : undefined);
}

/**
 * §10.3 "Out of Office"/"Opening hours": a `user` acts only on their own user scope; `admin` and
 * `owner` act on any scope. `minRole: 'user'` on these operations defers the rest of RBAC here.
 * For a scope-addressed route (the scope itself is the input, nothing to enumerate) a mismatch is
 * a plain 403.
 */
export function assertOwnScopeOrAdmin(actor: Actor, scope: ScopeInput): void {
  if (!ownsScope(actor, scope)) {
    throw new OpError(HTTP_FORBIDDEN, 'forbidden');
  }
}

/**
 * `assertOwnScopeOrAdmin`, for an id-addressed route: `update`/`delete` already resolved `scope`
 * from a rule the caller named by id, so a 403 there would let a `user` tell an existing rule in
 * someone else's scope apart from an unknown id. Both answer `notFoundMessage` (404) instead.
 */
export function assertVisibleScope(
  actor: Actor,
  scope: ScopeInput,
  notFoundMessage: string
): void {
  if (!ownsScope(actor, scope)) {
    throw new OpError(HTTP_NOT_FOUND, notFoundMessage);
  }
}
