/**
 * Vitest's setup file (`vite.config.ts`). Under vitest, SvelteKit's `$app/env/private` holds the
 * environment taken when the config loads, while the tests set `process.env` case by case; this
 * makes each variable `src/env.ts` declares read `process.env` itself, so every read sees the
 * case's values. In the built server it is the environment adapter-node starts with, which
 * nothing changes after boot.
 */
import { vi } from 'vitest';

vi.mock('$app/env/private', async () => {
  const [{ env }, { variables }] = await Promise.all([
    import('node:process'),
    import('./env.js')
  ]);
  return Object.defineProperties(
    {},
    Object.fromEntries(
      Object.keys(variables).map(name => [
        name,
        { enumerable: true, get: () => env[name] }
      ])
    )
  );
});
