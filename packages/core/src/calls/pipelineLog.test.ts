import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { newId, nowIso, openDb, type Db } from '@zamfono/shared';
import { migrateForTest } from '@zamfono/shared/testDb.js';

import { AriClient } from '../ari/client.js';
import { FakeAri } from '../ari/fake.js';
import type { Logger } from '../ari/types.js';
import { eventually } from '../testing/eventually.js';
import { newCall } from './call.js';
import { ConfigCache, EventBus, Pipeline, StateStore } from './pipeline.js';

/** §7: "Every call-related line carries the per-call correlation id", the pipeline's own account
 * of a routing failure included. */

const noopLogger: Logger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined
};

describe('pipeline routing-failure log line', () => {
  // eslint-disable-next-line init-declarations -- assigned in beforeEach before each test runs
  let db: Db;
  // eslint-disable-next-line init-declarations -- assigned in beforeEach before each test runs
  let fakeAri: FakeAri;
  // eslint-disable-next-line init-declarations -- assigned in beforeEach before each test runs
  let ari: AriClient;
  // eslint-disable-next-line init-declarations -- assigned in beforeEach before each test runs
  let pipeline: Pipeline;
  let errors: Record<string, unknown>[] = [];

  beforeEach(async () => {
    db = openDb(':memory:');
    await migrateForTest(db);
    fakeAri = new FakeAri();
    const { url } = await fakeAri.listen();
    ari = new AriClient({
      url,
      user: 'zamfono',
      password: 'secret',
      app: 'zamfono',
      log: noopLogger
    });
    await ari.connect();
    errors = [];
    pipeline = new Pipeline({
      ari,
      cache: new ConfigCache(db),
      state: new StateStore(),
      bus: new EventBus(),
      cdr: {
        open: () => Promise.resolve(),
        finish: () => Promise.resolve(),
        captureQos: () => Promise.reject(new Error('rtp_statistics failed'))
      },
      now: nowIso,
      logger: {
        ...noopLogger,
        error: fields => {
          if (typeof fields !== 'string') {
            errors.push(fields);
          }
        }
      },
      trunkState: null,
      presence: null
    });
  });

  afterEach(async () => {
    await ari.close();
    await fakeAri.close();
    await db.destroy();
  });

  it('names the call whose channel event failed to route', async () => {
    const channel = fakeAri.addChannel({});
    const call = newCall({
      id: newId(),
      direction: 'inbound',
      callerChannelId: channel.id,
      from: '+15559999',
      to: '+15551234',
      startedAt: nowIso(),
      logLevel: 'events',
      callLogMaxBytes: 1_048_576
    });
    pipeline.registerCall(call);

    fakeAri.emit({
      type: 'ChannelHangupRequest',
      timestamp: nowIso(),
      application: 'zamfono',
      channel
    });
    await eventually(() => {
      expect(errors).toEqual([
        expect.objectContaining({
          event: 'ChannelHangupRequest',
          callId: call.id
        })
      ]);
    });
  });
});
