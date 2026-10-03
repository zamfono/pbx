import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { newId, nowIso } from '@zamfono/shared';

import type { FakeAri } from '../testing/ari/fake.js';
import { eventually } from '../testing/eventually.js';
import { noopCdr, noopLogger } from '../testing/pipelineDeps.js';
import { startRig, type Rig } from '../testing/pipelineRig.js';
import { newCall } from './call.js';
import type { Pipeline } from './pipeline.js';

/** §7: "Every call-related line carries the per-call correlation id", the pipeline's own account
 * of a routing failure included. */

describe('pipeline routing-failure log line', () => {
  let rig: Rig;
  let fakeAri: FakeAri;
  let pipeline: Pipeline;
  let errors: Record<string, unknown>[] = [];

  beforeEach(async () => {
    errors = [];
    rig = await startRig({
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
    });
    ({ fakeAri, pipeline } = rig);
  });

  afterEach(async () => {
    await rig.stop();
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
