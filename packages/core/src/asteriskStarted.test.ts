import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { CoreStreamFrame } from '@zamfono/shared';

import { AriClient } from './ari/client.js';
import { FakeAri } from './ari/fake.js';
import type { Logger } from './ari/types.js';
import { announceAsteriskStartOnConnect } from './asteriskStarted.js';
import { EventBus } from './internal/eventBus.js';

type LogFn = Logger['info'];

function spyLogger(): Logger & { warn: ReturnType<typeof vi.fn<LogFn>> } {
  return {
    debug: vi.fn<LogFn>(),
    info: vi.fn<LogFn>(),
    warn: vi.fn<LogFn>(),
    error: vi.fn<LogFn>()
  };
}

// The fake Asterisk's `startup_time` (`FAKE_ASTERISK_STARTUP_TIME`), `+0000` read as UTC.
const STARTED = '2026-09-29T08:00:00.000Z';

describe('announceAsteriskStartOnConnect (§10.4 "After a restart")', () => {
  let fake: FakeAri;
  let ari: AriClient;

  beforeEach(async () => {
    fake = new FakeAri();
    const { url } = await fake.listen();
    ari = new AriClient({
      url,
      user: 'zamfono',
      password: 'secret',
      app: 'zamfono',
      log: spyLogger()
    });
  });

  afterEach(async () => {
    await ari.close();
    await fake.close();
  });

  it('announces the Asterisk start on the internal stream at every ARI connection', async () => {
    const bus = new EventBus();
    const frames: CoreStreamFrame[] = [];
    bus.subscribeStream(frame => {
      frames.push(frame);
    });
    announceAsteriskStartOnConnect(ari, bus, spyLogger());
    await ari.connect();
    await vi.waitFor(() => {
      expect(frames).toHaveLength(1);
    });

    const reconnected = new Promise<void>(resolve => {
      ari.once('connected', () => {
        resolve();
      });
    });
    fake.disconnectClient();
    await reconnected;
    await vi.waitFor(() => {
      expect(frames).toHaveLength(2);
    });
    expect(frames).toEqual([
      { type: 'asterisk.started', asteriskStartedAt: STARTED },
      { type: 'asterisk.started', asteriskStartedAt: STARTED }
    ]);
  });

  it('reads an unreadable start time again until it is read, and announces it then', async () => {
    vi.useFakeTimers();
    try {
      const log = spyLogger();
      const failure = new Error('ARI: unreadable startup_time "soon"');
      // A client whose Asterisk does not say at first: only the events and
      // `asterisk.startupTime` matter.
      const stub = Object.assign(new EventEmitter(), {
        asterisk: {
          startupTime: vi
            .fn()
            .mockRejectedValueOnce(failure)
            .mockRejectedValueOnce(failure)
            .mockResolvedValue(STARTED)
        }
      });
      const bus = new EventBus();
      const frames: CoreStreamFrame[] = [];
      bus.subscribeStream(frame => {
        frames.push(frame);
      });
      announceAsteriskStartOnConnect(stub as unknown as AriClient, bus, log);
      stub.emit('connected');
      await vi.advanceTimersByTimeAsync(0);
      expect(log.warn).toHaveBeenCalledWith(
        { error: failure },
        expect.stringContaining('asterisk start time unavailable')
      );
      expect(frames).toEqual([]);

      // The ARI clients' backoff: a second, then two.
      await vi.advanceTimersByTimeAsync(1000);
      expect(frames).toEqual([]);
      await vi.advanceTimersByTimeAsync(2000);

      expect(stub.asterisk.startupTime).toHaveBeenCalledTimes(3);
      expect(frames).toEqual([
        { type: 'asterisk.started', asteriskStartedAt: STARTED }
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('stops reading once the connection whose start it reads has dropped', async () => {
    vi.useFakeTimers();
    try {
      const stub = Object.assign(new EventEmitter(), {
        asterisk: {
          startupTime: vi.fn().mockRejectedValue(new Error('ARI: 503'))
        }
      });
      announceAsteriskStartOnConnect(
        stub as unknown as AriClient,
        new EventBus(),
        spyLogger()
      );
      stub.emit('connected');
      await vi.advanceTimersByTimeAsync(0);
      stub.emit('disconnected');
      await vi.advanceTimersByTimeAsync(60_000);

      expect(stub.asterisk.startupTime).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
