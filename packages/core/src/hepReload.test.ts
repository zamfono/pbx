import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AriClient } from './ari/client.js';
import { FakeAri } from './ari/fake.js';
import { AriError, type Logger } from './ari/types.js';
import { reloadHepOnConnect } from './hepReload.js';

const HTTP_CONFLICT = 409;

type LogFn = Logger['info'];

function spyLogger(): Logger & {
  info: ReturnType<typeof vi.fn<LogFn>>;
  warn: ReturnType<typeof vi.fn<LogFn>>;
} {
  return {
    debug: vi.fn<LogFn>(),
    info: vi.fn<LogFn>(),
    warn: vi.fn<LogFn>(),
    error: vi.fn<LogFn>()
  };
}

describe('reloadHepOnConnect (§7 level sip, §9.1)', () => {
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

  function hepReloads(): number {
    return fake.calls.filter(
      call => call.method === 'PUT' && call.path === 'asterisk/modules/res_hep'
    ).length;
  }

  it('reloads res_hep when the ARI connection opens, and again on every reconnection', async () => {
    const log = spyLogger();
    reloadHepOnConnect(ari, true, log);
    await ari.connect();
    await vi.waitFor(() => {
      expect(hepReloads()).toBe(1);
    });

    const reconnected = new Promise<void>(resolve => {
      ari.once('connected', () => {
        resolve();
      });
    });
    fake.disconnectClient();
    await reconnected;
    await vi.waitFor(() => {
      expect(hepReloads()).toBe(2);
    });
    expect(log.info).toHaveBeenCalledTimes(2);
    expect(log.info).toHaveBeenCalledWith(
      { module: 'res_hep' },
      expect.stringContaining('res_hep reloaded')
    );
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('leaves res_hep alone while HEP is disabled, when Asterisk has not loaded it', async () => {
    reloadHepOnConnect(ari, false, spyLogger());
    await ari.connect();
    // Any reload would have been sent by the time a later request is answered.
    await ari.asterisk.startupTime();
    expect(hepReloads()).toBe(0);
  });

  it('logs a refused reload as a warning and throws nothing', async () => {
    const log = spyLogger();
    const refused = new AriError(HTTP_CONFLICT, {
      message: 'Module could not be reloaded'
    });
    const reloadModule = vi.fn().mockRejectedValue(refused);
    // A client whose reload Asterisk refuses: only the event and `asterisk.reloadModule` matter.
    const stub = Object.assign(new EventEmitter(), {
      asterisk: { reloadModule }
    });
    reloadHepOnConnect(stub as unknown as AriClient, true, log);
    stub.emit('connected');
    await vi.waitFor(() => {
      expect(log.warn).toHaveBeenCalledWith(
        { module: 'res_hep', error: refused },
        expect.stringContaining('res_hep reload failed')
      );
    });
    expect(reloadModule).toHaveBeenCalledWith('res_hep');
    expect(log.info).not.toHaveBeenCalled();
  });
});
