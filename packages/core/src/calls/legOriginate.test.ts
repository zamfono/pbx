import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';

import { newId, nowIso } from '@zamfono/shared';

import { AriError, defaultChannel, type CreateParams } from '../ari/types.js';
import type { LogLevel } from '../callLog.js';
import { newCall } from './call.js';
import {
  originateLeg,
  PlacementError,
  STASIS_WAIT_MS
} from './legOriginate.js';
import type { Pipeline } from './pipeline.js';

/** A stand-in pipeline whose ARI and CDR record, in order, what the leg's originate did. */
function stubPipeline(
  options: {
    dialFails?: boolean;
    enterStasis?: boolean;
    createFails?: boolean;
  } = {}
): {
  pipeline: Pipeline;
  steps: string[];
  created: CreateParams[];
  releaseJoin: () => void;
} {
  const steps: string[] = [];
  const created: CreateParams[] = [];
  const join = Promise.withResolvers<undefined>();
  const events = new EventEmitter();
  const pipeline = {
    deps: {
      ari: {
        on: events.on.bind(events),
        off: events.off.bind(events),
        channels: {
          create: (params: CreateParams) => {
            steps.push('create');
            created.push(params);
            if (options.createFails === true) {
              return Promise.reject(new AriError(400, 'Allocation failed'));
            }
            const channel = defaultChannel({ id: 'leg-1', state: 'Down' });
            // Asterisk puts the created channel in the app once it has answered the create.
            setTimeout(() => {
              if (options.enterStasis !== false) {
                steps.push('stasisStart');
                events.emit('event', { type: 'StasisStart', channel });
              }
            }, 0);
            return Promise.resolve(channel);
          },
          dial: (id: string, timeout: number) => {
            steps.push(`dial ${id} ${timeout}`);
            return options.dialFails === true
              ? Promise.reject(new AriError(409, 'Channel not found'))
              : Promise.resolve();
          },
          hangup: (id: string) => {
            steps.push(`hangup ${id}`);
            return Promise.resolve();
          }
        }
      },
      cdr: {
        joinLeg: (_call: unknown, channelId: string) => {
          steps.push(`join ${channelId}`);
          return join.promise.then(() => {
            steps.push('joined');
          });
        }
      }
    }
  } as unknown as Pipeline;
  return {
    pipeline,
    steps,
    created,
    releaseJoin: () => {
      join.resolve(undefined);
    }
  };
}

function callAt(level: LogLevel): ReturnType<typeof newCall> {
  return newCall({
    id: newId(),
    direction: 'outbound',
    callerChannelId: 'caller-1',
    from: '101',
    to: '+498912345',
    startedAt: nowIso(),
    logLevel: level,
    callLogMaxBytes: 1_048_576
  });
}

const PARAMS = {
  endpoint: 'PJSIP/+498912345@trunk-a',
  app: 'zamfono' as const,
  appArgs: 'leg,call-1',
  channelId: 'leg-1',
  callerId: '"Anna" <+491110000>',
  variables: { 'CONNECTEDLINE(pres)': 'prohib' }
};

describe('originateLeg (§7 level sip)', () => {
  it('joins the SIP dialog of a sip-level call before the INVITE leaves', async () => {
    const { pipeline, steps, releaseJoin } = stubPipeline();
    const placing = originateLeg(pipeline, callAt('sip'), PARAMS);
    await new Promise(resolve => {
      setTimeout(resolve, 10);
    });
    // Created, in the app and joining, but not dialled while the join is still reading the Call-ID.
    expect(steps).toEqual(['create', 'join leg-1', 'stasisStart']);

    releaseJoin();
    await placing;

    expect(steps).toEqual([
      'create',
      'join leg-1',
      'stasisStart',
      'joined',
      'dial leg-1 30'
    ]);
  });

  it('dials a call below level sip without waiting for the join', async () => {
    const { pipeline, steps } = stubPipeline();

    await originateLeg(pipeline, callAt('events'), { ...PARAMS, timeout: 20 });

    expect(steps).toEqual([
      'create',
      'join leg-1',
      'stasisStart',
      'dial leg-1 20'
    ]);
  });

  // Asterisk answers the create before its own thread puts the channel in the app; a dial ahead
  // of that is refused with 409 "Channel not in Stasis application".
  it('dials the created channel only once it has entered the app, and never one that did not', async () => {
    vi.useFakeTimers();
    try {
      const { pipeline, steps } = stubPipeline({ enterStasis: false });
      const placing = originateLeg(pipeline, callAt('events'), PARAMS);
      const failed = expect(placing).rejects.toMatchObject({
        name: 'PlacementError',
        step: 'stasis'
      });
      await vi.advanceTimersByTimeAsync(STASIS_WAIT_MS - 1);
      expect(steps).toEqual(['create', 'join leg-1']);

      // Never entered: not placed, the created channel hung up.
      await vi.advanceTimersByTimeAsync(1);
      await failed;
      expect(steps).toEqual(['create', 'join leg-1', 'hangup leg-1']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('throws a placement error, dialling nothing, when the create is refused', async () => {
    const { pipeline, steps } = stubPipeline({ createFails: true });

    await expect(
      originateLeg(pipeline, callAt('events'), PARAMS)
    ).rejects.toMatchObject({ name: 'PlacementError', step: 'create' });
    expect(steps).toEqual(['create']);
  });

  it('sets the caller ID as the originate would, the leg’s own variables after it', async () => {
    const { pipeline, created } = stubPipeline();

    await originateLeg(pipeline, callAt('events'), PARAMS);

    expect(created).toEqual([
      {
        endpoint: PARAMS.endpoint,
        app: 'zamfono',
        appArgs: 'leg,call-1',
        channelId: 'leg-1',
        variables: {
          'CALLERID(all)': '"Anna" <+491110000>',
          'CONNECTEDLINE(all)': '"Anna" <+491110000>',
          'CONNECTEDLINE(pres)': 'prohib'
        }
      }
    ]);
  });

  it('hangs the created channel up and throws when the dial is refused', async () => {
    const { pipeline, steps } = stubPipeline({ dialFails: true });

    const placing = originateLeg(pipeline, callAt('events'), PARAMS);
    await expect(placing).rejects.toBeInstanceOf(PlacementError);
    await expect(placing).rejects.toMatchObject({
      step: 'dial',
      cause: expect.any(AriError) as unknown
    });
    expect(steps.at(-1)).toBe('hangup leg-1');
  });
});
