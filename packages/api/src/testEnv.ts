/**
 * Vitest's setup file (`vite.config.ts`). Under vitest, SvelteKit's `$env/dynamic/private` is a
 * copy of the environment taken when the config loads, while the tests set `process.env` case by
 * case; this makes it `process.env` itself, so every read sees the case's values. In the built
 * server it is the environment adapter-node starts with, which nothing changes after boot.
 */
import { vi } from 'vitest';

vi.mock('$env/dynamic/private', async () => {
  const { env } = await import('node:process');
  return { env };
});
