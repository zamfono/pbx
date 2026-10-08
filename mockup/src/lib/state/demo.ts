/**
 * Demo controls outside the product: *Reset demo* restores the seed and lets other modules (Mucki's
 * histories, the simulator) reset themselves through hooks.
 */
import { resetDb } from '#lib/api/store.svelte.js';

const resetHooks = new Set<() => void>();

export function onDemoReset(hook: () => void): () => void {
  resetHooks.add(hook);
  return () => resetHooks.delete(hook);
}

export function resetDemo(): void {
  resetDb();
  for (const hook of resetHooks) {
    hook();
  }
}
