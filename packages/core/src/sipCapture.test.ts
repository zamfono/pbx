import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { newId } from '@zamfono/shared';

import { AriClient } from './ari/client.js';
import { FakeAri } from './ari/fake.js';
import { newCall, type Call } from './calls/call.js';
import { SipCapture, type SipMessage } from './sipCapture.js';
import { noopLogger } from './testing/pipelineDeps.js';

/** §7 level `sip`: "the call's SIP messages", every dialog's, the INVITE and early responses
 * that race the join included. */

function buildCall(): Call {
  return newCall({
    id: newId(),
    direction: 'inbound',
    callerChannelId: 'caller-channel',
    from: '+15559999',
    to: '+15551000',
    startedAt: '2026-01-01T00:00:00.000Z',
    logLevel: 'sip',
    callLogMaxBytes: 1_048_576
  });
}

function message(callId: string, payload: string): SipMessage {
  return { callId, at: '2026-01-01T00:00:00.000Z', direction: 'in', payload };
}

function loggedPayloads(call: Call): string[] {
  return (call.log.finish().log ?? '')
    .split('\n')
    .filter(Boolean)
    .map(line => (JSON.parse(line) as { raw?: string }).raw ?? '');
}

describe('SipCapture', () => {
  let fakeAri: FakeAri;
  let ari: AriClient;
  let clock = 0;
  let capture: SipCapture;
  // The Call-ID lookup each `register` starts, for `joined` to wait on.
  let lookups: Promise<unknown>[] = [];

  /**
   * Resolves once every `register` so far has read its channel's Call-ID and joined it: the join
   * runs in the lookup's own reaction, which is registered before this one and so runs first.
   */
  async function joined(): Promise<void> {
    await Promise.allSettled(lookups);
  }

  beforeEach(async () => {
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
    lookups = [];
    const getVariable = ari.channels.getVariable.bind(ari.channels);
    vi.spyOn(ari.channels, 'getVariable').mockImplementation((id, name) => {
      const lookup = getVariable(id, name);
      lookups.push(lookup);
      return lookup;
    });
    clock = 1_000_000;
    capture = new SipCapture(ari, () => clock);
  });

  afterEach(async () => {
    await ari.close();
    await fakeAri.close();
  });

  /** A channel whose `CHANNEL(pjsip,call-id)` is `sipCallId`. */
  function channelWithCallId(sipCallId: string): string {
    const channel = fakeAri.addChannel({});
    fakeAri.channelVariables.set(
      `${channel.id}:CHANNEL(pjsip,call-id)`,
      sipCallId
    );
    return channel.id;
  }

  it('hands a call the INVITE and early responses that arrived before its dialog was joined', async () => {
    const call = buildCall();
    const channelId = channelWithCallId('caller@10.0.0.1');

    capture.message(message('caller@10.0.0.1', 'INVITE sip:101@pbx SIP/2.0'));
    capture.message(message('caller@10.0.0.1', 'SIP/2.0 100 Trying'));
    await capture.register(call, channelId);
    await joined();
    capture.message(message('caller@10.0.0.1', 'SIP/2.0 180 Ringing'));

    expect(loggedPayloads(call)).toEqual([
      'INVITE sip:101@pbx SIP/2.0',
      'SIP/2.0 100 Trying',
      'SIP/2.0 180 Ringing'
    ]);
  });

  it('joins every leg dialog to the call, not the caller alone', async () => {
    const call = buildCall();
    await capture.register(call, channelWithCallId('caller@10.0.0.1'));
    await capture.register(call, channelWithCallId('leg@10.0.0.2'));
    await joined();

    capture.message(
      message('leg@10.0.0.2', 'INVITE sip:e101-da@phone SIP/2.0')
    );

    expect(loggedPayloads(call)).toEqual(['INVITE sip:e101-da@phone SIP/2.0']);
  });

  it('lets a held message age out rather than reach a call joined long after it', async () => {
    const call = buildCall();
    const channelId = channelWithCallId('late@10.0.0.1');

    capture.message(message('late@10.0.0.1', 'INVITE sip:101@pbx SIP/2.0'));
    clock += 60_000;
    await capture.register(call, channelId);
    await joined();

    expect(loggedPayloads(call)).toEqual([]);
  });

  it('never hands a call the held messages of another dialog', async () => {
    const call = buildCall();
    const channelId = channelWithCallId('caller@10.0.0.1');

    capture.message(message('other@10.0.0.9', 'OPTIONS sip:pbx SIP/2.0'));
    await capture.register(call, channelId);
    await joined();

    expect(loggedPayloads(call)).toEqual([]);
  });
});
