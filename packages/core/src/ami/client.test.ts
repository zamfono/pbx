import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { FakeAmi, invalidAccountIdText } from '../testing/ami/fake.js';
import { noopLogger } from '../testing/pipelineDeps.js';
import { AmiClient } from './client.js';
import type { AmiEvent } from './frame.js';

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

  it('resolves send() on the Success response of an action that lists no events', async () => {
    fake.registrations.push({
      ObjectName: 'trunk-1',
      ClientUri: 'sip:acct@sip.example.com',
      ServerUri: 'sip:sip.example.com',
      Status: 'Registered'
    });
    await client.connect();
    await expect(
      client.send('PJSIPRegister', { Registration: 'trunk-1' })
    ).resolves.toBeUndefined();
    expect(fake.actions).toEqual([
      expect.objectContaining({
        Action: 'PJSIPRegister',
        Registration: 'trunk-1'
      })
    ]);
  });

  it('rejects send() with the message of an Error response', async () => {
    await client.connect();
    await expect(
      client.send('PJSIPRegister', { Registration: 'trunk-unknown' })
    ).rejects.toThrow('Unable to retrieve registration entry');
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

  it('emits a security event as Asterisk writes it', async () => {
    await client.connect();
    const received = new Promise<AmiEvent>(resolve => {
      client.once('event', resolve);
    });
    fake.write(invalidAccountIdText('scanner', 'IPV4/UDP/192.0.2.66/5060'));
    await expect(received).resolves.toMatchObject({
      Event: 'InvalidAccountID',
      AccountID: 'scanner',
      RemoteAddress: 'IPV4/UDP/192.0.2.66/5060'
    });
  });

  // TASK-93: a SIP From user's %0D%0A reaches a security event's AccountID unescaped.
  it('drops the frames a CR/LF in an AccountID forges', async () => {
    await client.connect();
    const events: AmiEvent[] = [];
    client.on('event', (event: AmiEvent) => {
      events.push(event);
    });
    let settled = false;
    // The fake answers Success and lists nothing: the action waits for its Complete event.
    const pending = client
      .action('PJSIPShowEndpoint', { Endpoint: 'e200' })
      .finally(() => {
        settled = true;
      });
    const guessedIds = ['1', '2', '3'];
    for (const accountId of [
      '\r\nRemoteAddress: 203.0.113.200/\r\n\r\n',
      'x\r\n\r\nEvent: SuccessfulAuth',
      'x\r\nEvent: SuccessfulAuth',
      '\r\n\r\nEvent: Registry\r\nStatus: Registered',
      '\r\n\r\nEvent: Registry\r\nPrivilege: x',
      ...guessedIds.flatMap(id => [
        `x\r\n\r\nActionID: ${id}\r\nResponse: Error`,
        `\r\n\r\nResponse: Error\r\nActionID: ${id}`,
        `\r\n\r\nEvent: Complete\r\nActionID: ${id}`
      ])
    ]) {
      fake.write(invalidAccountIdText(accountId, 'IPV4/UDP/192.0.2.66/5060'));
    }
    const registry = {
      Event: 'Registry',
      ChannelType: 'PJSIP',
      Username: 'sip:acct@sip.example.com',
      Domain: 'sip:sip.example.com',
      Status: 'Registered'
    };
    const received = new Promise<void>(resolve => {
      client.once('event', () => {
        resolve();
      });
    });
    fake.emit(registry);
    await received;
    expect(events).toEqual([{ Privilege: 'system,all', ...registry }]);
    expect(settled).toBe(false);

    const actionId = fake.actions.at(-1)?.ActionID ?? '';
    fake.write(
      `Event: EndpointDetailComplete\r\nActionID: ${actionId}\r\nEventList: Complete\r\nListItems: 0\r\n\r\n`
    );
    await expect(pending).resolves.toEqual([
      expect.objectContaining({ Event: 'EndpointDetailComplete' })
    ]);
  });
});
