import { afterEach, describe, expect, it, vi } from 'vitest';

import { nowIso, openDb, type Db } from '@zamfono/shared';

import { AmiClient } from './ami/client.js';
import { AriClient } from './ari/client.js';
import type { Logger } from './ari/types.js';
import { buildPipeline } from './boot.js';
import { Recorder } from './calls/recording.js';
import { TrunkState } from './calls/trunkState.js';
import { ConfigCache, EventBus, StateStore } from './internal/server.js';
import { Presence } from './presence.js';

const noopLogger: Logger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined
};

describe('buildPipeline', () => {
  // eslint-disable-next-line init-declarations -- assigned in the test before any use
  let db: Db;

  afterEach(async () => {
    vi.restoreAllMocks();
    await db.destroy();
  });

  /** A pipeline over clients that never connect: building it wires listeners and reads nothing. */
  function build(
    stackTz: string
  ): ReturnType<typeof buildPipeline> & { state: StateStore } {
    db = openDb(':memory:');
    const ari = new AriClient({
      url: 'http://127.0.0.1:1',
      user: 'zamfono',
      password: 'secret',
      app: 'zamfono',
      log: noopLogger
    });
    const ami = new AmiClient({
      host: '127.0.0.1',
      port: 1,
      username: 'zamfono',
      password: 'secret',
      log: noopLogger
    });
    const cache = new ConfigCache(db);
    const state = new StateStore();
    const bus = new EventBus();
    const deps = { ari, cache, state, bus, now: nowIso };
    const built = buildPipeline({
      ...deps,
      db,
      log: noopLogger,
      mediaDir: '/media',
      trunkState: new TrunkState({ ...deps, ami }),
      presence: new Presence({ ...deps, db }),
      stackTz
    });
    return { ...built, state };
  }

  it('serves its recorder\'s mix failures in the live state (§10.2 "visible in /metrics")', async () => {
    // The count the recorder keeps as mixes fail; `recording.test.ts` covers how it grows.
    vi.spyOn(Recorder.prototype, 'mixFailureCount', 'get').mockReturnValue(2);

    const { state } = build('UTC');

    expect((await state.snapshot()).recordingMixFailures).toBe(2);
  });

  it("hands the stack's TZ to the pipeline, the tenant clock while settings.timezone is NULL (§11.4)", () => {
    const { pipeline } = build('Europe/Vienna');

    expect(pipeline.deps.stackTz).toBe('Europe/Vienna');
  });
});
