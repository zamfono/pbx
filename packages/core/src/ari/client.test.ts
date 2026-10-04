import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { FakeAri } from '../testing/ari/fake.js';
import { noopLogger } from '../testing/pipelineDeps.js';
import { AriClient } from './client.js';
import type { AriEvent } from './events.js';
import { AriError } from './types.js';

const TEST_APP = 'zamfono';

describe('AriClient', () => {
  let fake: FakeAri;
  let client: AriClient;

  beforeEach(async () => {
    fake = new FakeAri();
    const { url } = await fake.listen();
    client = new AriClient({
      url,
      user: 'zamfono',
      password: 'secret',
      app: TEST_APP,
      log: noopLogger
    });
  });

  afterEach(async () => {
    await client.close();
    await fake.close();
  });

  it('connects to the fake and receives an emitted event', async () => {
    const received = new Promise<AriEvent>(resolve => {
      client.once('event', resolve);
    });
    await client.connect();
    fake.emit({
      type: 'StasisStart',
      timestamp: '2026-01-01T00:00:00Z',
      application: 'zamfono',
      args: []
    });
    await expect(received).resolves.toMatchObject({ type: 'StasisStart' });
  });

  it('reconnects after the fake drops the socket', async () => {
    await client.connect();
    const disconnected = new Promise<void>(resolve => {
      client.once('disconnected', () => {
        resolve();
      });
    });
    const reconnected = new Promise<void>(resolve => {
      client.once('connected', () => {
        resolve();
      });
    });
    fake.disconnectClient();
    await disconnected;
    await reconnected;
  });

  it('hangs up with a Q.850 cause as the reason_code query parameter', async () => {
    await client.connect();
    const channel = fake.addChannel({});
    await client.channels.hangup(channel.id, { reasonCode: 21 });
    const hangupCall = fake.calls.find(
      call => call.method === 'DELETE' && call.path.startsWith('channels/')
    );
    expect(hangupCall?.path).toBe(`channels/${channel.id}`);
    expect(
      `${hangupCall?.method} /ari/${hangupCall?.path}?${hangupCall?.qs}`
    ).toBe(`DELETE /ari/channels/${channel.id}?reason_code=21`);
  });

  it('throws AriError with status 404 for an unknown channel', async () => {
    await client.connect();
    await expect(client.channels.answer('missing')).rejects.toBeInstanceOf(
      AriError
    );
    await expect(client.channels.answer('missing')).rejects.toMatchObject({
      status: 404
    });
  });
  it('reads a channel variable, the SIP Call-ID HEP correlation needs (§7)', async () => {
    const channel = fake.addChannel({});
    fake.channelVariables.set(
      `${channel.id}:CHANNEL(pjsip,call-id)`,
      'abc@1.2.3.4'
    );

    const value = await client.channels.getVariable(
      channel.id,
      'CHANNEL(pjsip,call-id)'
    );

    expect(value).toBe('abc@1.2.3.4');
  });

  it('answers null for a channel variable that is not set', async () => {
    const channel = fake.addChannel({});

    const value = await client.channels.getVariable(channel.id, 'NOPE');

    expect(value).toBeNull();
  });

  it('answers null for a dialplan function with nothing to read, an absent SIP header', async () => {
    const channel = fake.addChannel({});

    const value = await client.channels.getVariable(
      channel.id,
      'PJSIP_HEADER(read,Privacy)'
    );

    expect(value).toBeNull();
  });
});
