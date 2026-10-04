import { describe, expect, it, vi } from 'vitest';

import { getCoreClient } from '#lib/server/coreClient.js';
import { stubCoreClient } from '#testing/coreClientStub.js';
import { asRun, makeTestDb } from '#testing/testDb.js';

import { runOperation } from './runner.js';

import './index.js';

function settlesWithin<T>(promise: Promise<T>, ms: number): Promise<boolean> {
  return Promise.race([
    promise.then(() => true),
    new Promise<boolean>(resolve => {
      setTimeout(() => {
        resolve(false);
      }, ms);
    })
  ]);
}

/** A deferred promise: `promise` settles once `resolve` is called. */
function deferred<T = void>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(settle => {
    resolve = settle;
  });
  return { promise, resolve };
}

describe('what an operation waits on outside the database', () => {
  it("leaves the database to other requests while an operation waits for core's answer", async () => {
    const db = await makeTestDb();
    const coreAnswer = deferred<{ callId: string }>();
    vi.mocked(getCoreClient).mockReturnValue(
      stubCoreClient({ originate: () => coreAnswer.promise })
    );
    const originate = runOperation(
      db,
      'calls.originate',
      { target: '101' },
      asRun()
    );
    await new Promise(resolve => {
      setTimeout(resolve, 10);
    });

    // Any other request's read meanwhile, a sign-in or a list.
    const otherRead = db.selectFrom('users').select('id').execute();
    const answeredMeanwhile = await settlesWithin(otherRead, 200);
    coreAnswer.resolve({ callId: 'c1' });
    await originate;

    expect(answeredMeanwhile).toBe(true);
  });
});
