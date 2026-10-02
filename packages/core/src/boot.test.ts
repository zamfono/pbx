import { afterEach, describe, expect, it, vi } from 'vitest';

import { nowIso, openDb, type Db } from '@zamfono/shared';

import { AmiClient } from './ami/client.js';
import { AriClient } from './ari/client.js';
import { buildPipeline } from './boot.js';
import { TrunkState } from './calls/trunkState.js';
import { readEnv } from './env.js';
import { EventBus } from './internal/eventBus.js';
import { ConfigCache } from './internal/snapshot.js';
import { StateStore } from './internal/stateStore.js';
import { Presence } from './presence.js';
import { noopLogger } from './testing/pipelineDeps.js';

describe('buildPipeline', () => {
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
      env: {
        ...readEnv({ ARI_PASSWORD: 'secret', AMI_PASSWORD: 'secret' }),
        tz: stackTz
      },
      trunkState: new TrunkState({ log: noopLogger, ...deps, ami }),
      presence: new Presence({ log: noopLogger, ...deps, db })
    });
    return { ...built, state };
  }

  it("hands the stack's TZ to the pipeline, the tenant clock while settings.timezone is NULL (§11.4)", () => {
    const { pipeline } = build('Europe/Vienna');

    expect(pipeline.deps.stackTz).toBe('Europe/Vienna');
  });
});
