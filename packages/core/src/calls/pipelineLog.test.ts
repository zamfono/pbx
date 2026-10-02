import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { newId, nowIso, openDb, type Db } from '@zamfono/shared';
import { migrateForTest } from '@zamfono/shared/testDb.js';

import { AriClient } from '../ari/client.js';
import { FakeAri } from '../ari/fake.js';
import { eventually } from '../testing/eventually.js';
import {
  noopCdr,
  noopLogger,
  testPipelineDeps
} from '../testing/pipelineDeps.js';
import { newCall } from './call.js';
import { Pipeline } from './pipeline.js';

/** §7: "Every call-related line carries the per-call correlation id", the pipeline's own account
 * of a routing failure included. */

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
    pipeline = new Pipeline(
      testPipelineDeps(ari, db, {
        cdr: {
          ...noopCdr(),
          open: () => Promise.resolve(),
          finish: () => Promise.resolve(),
          noteQosLegs: () => {
            throw new Error('noting the QoS legs failed');
          }
        },
        logger: {
          ...noopLogger,
          error: fields => {
            if (typeof fields !== 'string') {
              errors.push(fields);
            }
          }
        }
      })
    );
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
