import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AriClient } from '../ari/client.js';
import { FakeAri } from '../ari/fake.js';
import type { Logger } from '../ari/types.js';
import { recordFormatFor } from './recordingRate.js';

const NATIVE_FORMAT = 'CHANNEL(audionativeformat)';

function debugLogger(): Logger & { debugs: unknown[][] } {
  const debugs: unknown[][] = [];
  return {
    debugs,
    debug: (...args) => {
      debugs.push(args);
    },
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined
  };
}

describe('recordFormatFor (§10.2 "Sample rate")', () => {
  let fakeAri: FakeAri;
  let ari: AriClient;

  beforeEach(async () => {
    fakeAri = new FakeAri();
    const { url } = await fakeAri.listen();
    ari = new AriClient({
      url,
      user: 'zamfono',
      password: 'secret',
      app: 'zamfono',
      log: debugLogger()
    });
    await ari.connect();
  });

  afterEach(async () => {
    await ari.close();
    await fakeAri.close();
  });

  /** A mixing bridge holding the caller and the answering device, each with its negotiated
   * codec as Asterisk reports a PJSIP channel's native format. */
  async function bridgeCall(
    callerFormat: string,
    deviceFormat: string
  ): Promise<void> {
    fakeAri.addChannel({ id: 'caller' });
    fakeAri.addChannel({ id: 'device' });
    fakeAri.channelVariables.set(`caller:${NATIVE_FORMAT}`, callerFormat);
    fakeAri.channelVariables.set(`device:${NATIVE_FORMAT}`, deviceFormat);
    const bridge = await ari.bridges.create({ type: 'mixing' });
    await ari.bridges.addChannel(bridge.id, 'caller');
    await ari.bridges.addChannel(bridge.id, 'device');
  }

  it("records the narrowband device's participation at 16 kHz when the caller is wideband", async () => {
    await bridgeCall('(g722)', '(alaw)');

    await expect(recordFormatFor(ari, 'device', debugLogger())).resolves.toBe(
      'wav16'
    );
  });

  it('records at 8 kHz when both legs are narrowband', async () => {
    await bridgeCall('(alaw)', '(ulaw)');

    await expect(recordFormatFor(ari, 'device', debugLogger())).resolves.toBe(
      'wav'
    );
  });

  it('falls back to 8 kHz, logged at debug, when the codec lookup fails', async () => {
    await bridgeCall('(opus)', '(opus)');
    vi.spyOn(ari.channels, 'getVariable').mockRejectedValue(
      new Error('ARI unreachable')
    );
    const log = debugLogger();

    await expect(recordFormatFor(ari, 'device', log)).resolves.toBe('wav');
    expect(log.debugs).toHaveLength(1);
  });
});
