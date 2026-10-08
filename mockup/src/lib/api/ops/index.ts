/**
 * Registers every operation: each area module under `areas/` calls `defineOp` for its operations
 * (named as in the API registry, e.g. `users.create`).
 */
import.meta.glob(['./areas/*.ts', '!./areas/*.test.ts'], { eager: true });

export { call, allowed, operationNames } from './core';
