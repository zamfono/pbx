/**
 * Vitest's setup file (`vite.config.ts`). Under vitest, SvelteKit's `$app/env/private` holds the
 * environment taken when the config loads, while the tests set `process.env` case by case; this
 * makes each variable `src/env.ts` declares read `process.env` itself, so every read sees the
 * case's values. In the built server it is the environment adapter-node starts with, which
 * nothing changes after boot.
 */
import { vi } from 'vitest';

// The variables `src/env.ts` requires that a stack always has, from `.env` (§6.3 "Environment"),
// the image or Compose; a suite that needs a particular one, such as a media directory of its
// own, sets it.
process.env.FQDN ??= 'pbx.test';
process.env.CORE_URL ??= 'http://core.test';
process.env.MEDIA_DIR ??= '/nonexistent/media';
process.env.ASTERISK_GEN_DIR ??= '/nonexistent/asterisk-gen';

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

// No suite reaches a `core` or an Asterisk: the process's core client is one whose every request
// fails, as an unreachable `core`'s does, and a write's config propagation does nothing. A suite
// that needs `core` to answer sets `vi.mocked(getCoreClient)` (`stubCoreClient`), one that
// observes a propagation reads `vi.mocked(propagateConfig)`, and the suites of `propagation.ts`
// itself unmock it.
vi.mock('#lib/server/coreClient.js', async importOriginal => {
  const actual =
    await importOriginal<typeof import('#lib/server/coreClient.js')>();
  const unreachable = actual.createCoreClient('http://core.test', () =>
    Promise.reject(new Error('core unreachable'))
  );
  return { ...actual, getCoreClient: vi.fn(() => unreachable) };
});

vi.mock('#lib/server/propagation.js', async importOriginal => ({
  ...(await importOriginal<typeof import('#lib/server/propagation.js')>()),
  propagateConfig: vi.fn(() => Promise.resolve())
}));
