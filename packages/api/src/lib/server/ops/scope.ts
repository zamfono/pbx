import { expressionBuilder, type Expression, type SqlBool } from 'kysely';
import { z } from 'zod';

import { type DB, type Db } from '@zamfono/shared';

import { liveRow } from './rows.js';
import type { Context } from './types.js';

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

/** The filter matching the rows of `scope`: a NULL scope column matches NULL, the tenant's all three. */
export function inScope(scope: ScopeInput): Expression<SqlBool> {
  const eb = expressionBuilder<DB, 'oooRules' | 'openingHours'>();
  const columns = scopeColumns(scope);
  return eb.and([
    eb(
      'scopeUserId',
      columns.scopeUserId === null ? 'is' : '=',
      columns.scopeUserId
    ),
    eb(
      'scopeRingGroupId',
      columns.scopeRingGroupId === null ? 'is' : '=',
      columns.scopeRingGroupId
    ),
    eb(
      'scopeMenuId',
      columns.scopeMenuId === null ? 'is' : '=',
      columns.scopeMenuId
    )
  ]);
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

/** Whether `scope` is the caller's own user scope (§5.3). */
export function isOwnScope(ctx: Context, scope: ScopeInput): boolean {
  return scope.kind === 'user' && scope.id === ctx.actor.id;
}

/**
 * The `scope` of an operation addressing a scope (§10.3 "Out of Office", "Opening hours"): the
 * caller's own user scope alone.
 */
export function ownScopeInput(
  ctx: Context,
  input: { scope: ScopeInput }
): boolean {
  return isOwnScope(ctx, input.scope);
}

/** The live table each non-tenant scope kind names its owner in. */
const SCOPE_TABLES = {
  user: 'users',
  ringGroup: 'ringGroups',
  menu: 'menus'
} as const;

/**
 * Throws 404 unless `scope` names a live user, ring group or menu; the tenant scope always
 * exists. The runner checks a `user`'s own scope first (`ownScopeInput`), so a `user` learns
 * nothing about someone else's scope.
 */
export async function assertScopeExists(
  db: Db,
  scope: ScopeInput
): Promise<void> {
  if (scope.kind === 'tenant') {
    return;
  }
  await liveRow(
    db,
    SCOPE_TABLES[scope.kind],
    scope.id,
    `${scope.kind} '${scope.id}' not found`
  );
}
