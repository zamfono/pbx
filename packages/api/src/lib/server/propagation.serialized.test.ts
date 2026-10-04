import { afterEach, describe, expect, it, vi } from 'vitest';

import { seedSettings } from '@zamfono/shared/testDb.js';

import { stubCoreClient } from '#testing/coreClientStub.js';
import { makeTestDb } from '#testing/testDb.js';

import { getCoreClient } from './coreClient.js';
import { propagateConfig } from './propagation.js';

// The propagation under test, not the setup file's stand-in for it.
vi.unmock('./propagation.js');

/** Has `core` take the propagations' reloads one by one, each recorded under its name in `log`
 * and settling as its `answer` says. */
function coreAnswering(
  log: string[],
  answers: { name: string; answer: () => Promise<void> }[]
): void {
  vi.mocked(getCoreClient).mockReturnValue(
    stubCoreClient({
      configChanged: async kinds => {
        const next = answers.shift();
        log.push(`${next?.name ?? 'unexpected'}:${kinds.join(',')}`);
        return next?.answer();
      }
    })
  );
}

function flush(): Promise<void> {
  return new Promise(resolve => {
    setImmediate(resolve);
  });
}

afterEach(() => {
  vi.mocked(getCoreClient).mockReset();
});

// §3.1 "Config propagation": a propagation that overtook an older one could load a stale render.
describe('propagateConfig runs one propagation at a time', () => {
  it('starts a propagation only once the one before it has settled, even when it failed', async () => {
    const db = await makeTestDb();
    await seedSettings(db);
    const log: string[] = [];
    let release: () => void = () => undefined;
    coreAnswering(log, [
      {
        name: 'first',
        answer: () =>
          new Promise<void>((_resolve, reject) => {
            release = () => {
              reject(new Error('core refused'));
            };
          })
      },
      { name: 'second', answer: () => Promise.resolve() }
    ]);
    const first = propagateConfig(db, []);
    await flush();
    const second = propagateConfig(db, []);
    await flush();
    expect(log).toEqual(['first:']);

    release();
    await expect(first).rejects.toThrow('core refused');
    await second;
    // The failed first left the propagation pending, so the second reloads everything.
    expect(log).toEqual(['first:', 'second:pjsip,dialplan,moh']);
  });
});
