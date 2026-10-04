import type { Operation } from './types.js';

// The registry holds operations of differing `In`/`Out`; a caller resolves one by name and
// validates/dispatches through `Operation`'s own `input`/`run`, so nothing here needs to know a
// concrete pair. `unknown` erases both generics without `any` (disallowed by lint).
export type ErasedOperation = Operation<unknown, unknown, unknown>;

/** Every registered operation by name, filled by importing `$lib/server/ops/index.ts` (§10.3). */
export const registry = new Map<string, ErasedOperation>();

/** Adds `op` to the registry; throws if its name is already taken. */
export function register<In, Out, Prepared>(
  op: Operation<In, Out, Prepared>
): void {
  if (registry.has(op.name)) {
    throw new Error(`register: duplicate operation name '${op.name}'`);
  }
  registry.set(op.name, op as unknown as ErasedOperation);
}
