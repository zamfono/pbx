import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { CoreStreamFrame, Envelope } from '@zamfono/shared';

import { AriClient } from './ari/client.js';
import { FakeAri } from './ari/fake.js';
import type { Logger } from './ari/types.js';
import { announceAsteriskStartOnConnect } from './asteriskStarted.js';
import { EventBus } from './internal/server.js';

type LogFn = Logger['info'];

function spyLogger(): Logger & { warn: ReturnType<typeof vi.fn<LogFn>> } {
  return { info: vi.fn<LogFn>(), warn: vi.fn<LogFn>(), error: vi.fn<LogFn>() };
}

// The fake Asterisk's `startup_time` (`FAKE_ASTERISK_STARTUP_TIME`), `+0000` read as UTC.
const STARTED = '2026-09-29T08:00:00.000Z';

describe('announceAsteriskStartOnConnect (§10.4 "After a restart")', () => {
  // eslint-disable-next-line init-declarations -- assigned in beforeEach before each test runs
  let fake: FakeAri;
  // eslint-disable-next-line init-declarations -- assigned in beforeEach before each test runs
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

  it('announces the Asterisk start on the internal stream at every ARI connection, to no in-process subscriber', async () => {
    const bus = new EventBus();
    const frames: CoreStreamFrame[] = [];
    const envelopes: Envelope[] = [];
    bus.subscribeStream(frame => {
      frames.push(frame);
    });
    bus.subscribe(envelope => {
      envelopes.push(envelope);
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
    expect(envelopes).toEqual([]);
  });

  it('logs an unreadable start time as a warning and announces nothing', async () => {
    const log = spyLogger();
    const failure = new Error('ARI: unreadable startup_time "soon"');
    // A client whose Asterisk does not say: only the event and `asterisk.startupTime` matter.
    const stub = Object.assign(new EventEmitter(), {
      asterisk: { startupTime: vi.fn().mockRejectedValue(failure) }
    });
    const bus = new EventBus();
    const frames: CoreStreamFrame[] = [];
    bus.subscribeStream(frame => {
      frames.push(frame);
    });
    announceAsteriskStartOnConnect(stub as unknown as AriClient, bus, log);
    stub.emit('connected');
    await vi.waitFor(() => {
      expect(log.warn).toHaveBeenCalledWith(
        { error: failure },
        expect.stringContaining('asterisk start time unavailable')
      );
    });
    expect(frames).toEqual([]);
  });
});
