import type { Operation } from './types.js';

// The registry holds operations of differing `In`/`Out`; a caller resolves one by name and
// validates/dispatches through `Operation`'s own `input`/`run`, so nothing here needs to know a
// concrete pair. `unknown` erases both generics without `any` (disallowed by lint).
export type ErasedOperation = Operation<unknown, unknown>;

/** Every registered operation by name, filled by importing `$lib/server/ops/index.ts` (§10.3). */
export const registry = new Map<string, ErasedOperation>();

/**
 * Adds `op` to the registry; throws if its name is already taken, or if it neither is `readOnly`
 * nor opts out with `audit: false` yet omits `entity()` — the audit row the runner would write
 * for it needs `entity()` for `audit_log.entity_kind`/`entity_id`, which are `NOT NULL` (§11.2).
 */
export function register<In, Out>(op: Operation<In, Out>): void {
  if (registry.has(op.name)) {
    throw new Error(`register: duplicate operation name '${op.name}'`);
  }
  if (!op.readOnly && op.audit !== false && !op.entity) {
    throw new Error(
      `register: operation '${op.name}' must define entity() to audit a write`
    );
  }
  registry.set(op.name, op as unknown as ErasedOperation);
}
