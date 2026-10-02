import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { noopLogger } from '../testing/pipelineDeps.js';
import { AmiClient, type AmiEvent } from './client.js';
import { FakeAmi } from './fake.js';

describe('AmiClient', () => {
  let fake: FakeAmi;
  let client: AmiClient;

  beforeEach(async () => {
    fake = new FakeAmi();
    const { host, port } = await fake.listen();
    client = new AmiClient({
      host,
      port,
      username: 'zamfono',
      password: 'secret',
      log: noopLogger
    });
  });

  afterEach(async () => {
    await client.close();
    await fake.close();
  });

  it('logs in to the fake', async () => {
    await expect(client.connect()).resolves.toBeUndefined();
  });

  it('resolves action() with the fake registrations', async () => {
    fake.registrations.push({
      ObjectName: 'ext1',
      ClientUri: 'sip:ext1@pbx',
      ServerUri: 'sip:trunk',
      Status: 'Registered'
    });
    await client.connect();
    const events = await client.action('PJSIPShowRegistrationsOutbound');
    const details = events.filter(
      event => event.Event === 'OutboundRegistrationDetail'
    );
    expect(details).toEqual([
      expect.objectContaining({
        ObjectName: 'ext1',
        ClientUri: 'sip:ext1@pbx',
        ServerUri: 'sip:trunk',
        Status: 'Registered'
      })
    ]);
  });

  it('delivers an emitted Registry frame as an event', async () => {
    await client.connect();
    const received = new Promise<AmiEvent>(resolve => {
      client.once('event', resolve);
    });
    fake.emit({
      Event: 'Registry',
      ChannelType: 'PJSIP',
      Username: 'ext1',
      Domain: 'pbx',
      Status: 'Registered'
    });
    await expect(received).resolves.toMatchObject({
      Event: 'Registry',
      Status: 'Registered'
    });
  });

  it('reconnects and logs in again after the fake closes the socket', async () => {
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
});
