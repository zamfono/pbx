import { describe, expect, it } from 'vitest';

import type { ReloadKind } from '@zamfono/shared';

import type { CoreClient } from './coreClient.js';
import { propagateConfig } from './propagation.js';
import { keyringFromEnv } from './secretbox.js';
import { makeTestDb } from './testDb.js';

const kr = keyringFromEnv({
  SECRETBOX_KEY: `1:${Buffer.alloc(32, 7).toString('base64')}`
});

/** A `CoreClient` whose `configChanged` records its call and settles as `answer` says. */
function coreClient(
  log: string[],
  name: string,
  answer: () => Promise<void>
): CoreClient {
  const unused = (): Promise<never> => Promise.reject(new Error('not used'));
  return {
    configChanged: (kinds: ReloadKind[]) => {
      log.push(`${name}:${kinds.join(',')}`);
      return answer();
    },
    state: unused,
    originate: unused,
    transfer: unused,
    pickup: unused,
    hangup: unused,
    mwi: unused
  };
}

function flush(): Promise<void> {
  return new Promise(resolve => {
    setImmediate(resolve);
  });
}

// §3.1 "Config propagation": a propagation that overtook an older one could load a stale render.
describe('propagateConfig runs one propagation at a time', () => {
  it('starts a propagation only once the one before it has settled, even when it failed', async () => {
    const db = await makeTestDb();
    const log: string[] = [];
    let release: () => void = () => undefined;
    const first = propagateConfig(db, [], {
      kr,
      coreClient: coreClient(
        log,
        'first',
        () =>
          new Promise<void>((_resolve, reject) => {
            release = () => {
              reject(new Error('core refused'));
            };
          })
      )
    });
    await flush();
    const second = propagateConfig(db, [], {
      kr,
      coreClient: coreClient(log, 'second', () => Promise.resolve())
    });
    await flush();
    expect(log).toEqual(['first:']);

    release();
    await expect(first).rejects.toThrow('core refused');
    await second;
    expect(log).toEqual(['first:', 'second:']);
  });
});
