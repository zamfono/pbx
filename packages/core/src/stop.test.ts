import { afterEach, describe, expect, it, vi } from 'vitest';

import { AmiClient } from './ami/client.js';
import type { Logger } from './ari/types.js';
import { STOP_DRAIN_MS, stopOnSignal } from './stop.js';
import { noopLogger } from './testing/pipelineDeps.js';
import { answeredCall, startRig, type Rig } from './testing/pipelineRig.js';
import { seedUser } from './testing/seedRows.js';

describe('stopOnSignal', () => {
  let rig: Rig;
  // The fake's close waits on the requests it still holds.
  const unconfirmed = Promise.withResolvers<undefined>();

  afterEach(async () => {
    unconfirmed.resolve(undefined);
    vi.useRealTimers();
    await rig.stop();
  });

  it('stops after STOP_DRAIN_MS when a wind-down hangup never confirms, naming the call', async () => {
    rig = await startRig();
    const userId = await seedUser(rig.db, '101');
    const call = await answeredCall(rig, userId);
    rig.fakeAri.holdRequest = request =>
      request.method === 'DELETE' ? unconfirmed.promise : 0;
    const warnings: unknown[][] = [];
    const log: Logger = {
      ...noopLogger,
      warn: (...args: unknown[]) => {
        warnings.push(args);
      }
    };
    const ami = new AmiClient({
      host: '127.0.0.1',
      port: 1,
      username: 'zamfono',
      password: 'secret',
      log: noopLogger
    });
    const { close } = stopOnSignal({
      jobs: { stop: vi.fn() },
      hep: null,
      server: { close: () => Promise.resolve() },
      pipeline: rig.pipeline,
      ari: rig.ari,
      ami,
      log
    });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

    const stopped = close();
    await vi.advanceTimersByTimeAsync(STOP_DRAIN_MS);
    await stopped;

    expect(warnings).toEqual([
      [
        { handling: [], windingDown: [call.id], waitedMs: STOP_DRAIN_MS },
        'core stopping before its calls were wound down'
      ]
    ]);
  });
});
