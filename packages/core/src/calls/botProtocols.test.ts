import { describe, expect, it } from 'vitest';

import { botProtocol, type BotStart } from './botProtocols.js';

const START: BotStart = {
  callId: 'call-1',
  accountId: 'pbx.example.com',
  sampleRate: 8000,
  parameters: { callerNumber: '+15559999', sessionToken: 'zcs_x' }
};

function json(frame: string | Buffer): Record<string, unknown> {
  return JSON.parse(frame.toString()) as Record<string, unknown>;
}

// §9.4 "WebSocket targets": Twilio Media Streams, bidirectional.
describe('twilio', () => {
  it('opens with connected and start, callSid the call id, mu-law 8 kHz and the metadata as customParameters', () => {
    const [connected, start] = botProtocol('twilio').start(START);
    expect(json(connected ?? '')).toEqual({
      event: 'connected',
      protocol: 'Call',
      version: '1.0.0'
    });
    const parsed = json(start ?? '');
    expect(parsed).toMatchObject({
      event: 'start',
      sequenceNumber: '1',
      start: {
        accountSid: 'pbx.example.com',
        callSid: 'call-1',
        tracks: ['inbound'],
        customParameters: START.parameters,
        mediaFormat: {
          encoding: 'audio/x-mulaw',
          sampleRate: 8000,
          channels: 1
        }
      }
    });
    expect(parsed.streamSid).toBe(
      (parsed.start as { streamSid: string }).streamSid
    );
  });

  it('numbers media, dtmf, marks and stop on from start, the audio base64 mu-law', () => {
    const protocol = botProtocol('twilio');
    protocol.start(START);
    // Two linear samples, silence and the loudest negative: mu-law 0xff and 0x00.
    const payload = Buffer.from([0, 0, 0x00, 0x80]);
    expect(json(protocol.media(payload, 20))).toMatchObject({
      event: 'media',
      sequenceNumber: '2',
      media: {
        track: 'inbound',
        chunk: '1',
        timestamp: '20',
        payload: Buffer.from([0xff, 0x00]).toString('base64')
      }
    });
    expect(json(protocol.dtmf('5', 120))).toMatchObject({
      event: 'dtmf',
      sequenceNumber: '3',
      dtmf: { digit: '5' }
    });
    expect(json(protocol.marked('greeting'))).toMatchObject({
      event: 'mark',
      sequenceNumber: '4',
      mark: { name: 'greeting' }
    });
    expect(protocol.cleared(['a', 'b']).map(json)).toMatchObject([
      { event: 'mark', mark: { name: 'a' } },
      { event: 'mark', mark: { name: 'b' } }
    ]);
    expect(json(protocol.stop() ?? '')).toMatchObject({
      event: 'stop',
      sequenceNumber: '7',
      stop: { accountSid: 'pbx.example.com', callSid: 'call-1' }
    });
  });

  it('reads media, mark and clear from the bot and ignores anything else', () => {
    const protocol = botProtocol('twilio');
    const text = (value: unknown): Buffer => Buffer.from(JSON.stringify(value));
    expect(
      protocol.parse(
        text({
          event: 'media',
          streamSid: 'MZ1',
          media: { payload: Buffer.from([0xff, 0x00]).toString('base64') }
        }),
        false
      )
    ).toEqual({
      kind: 'audio',
      // Little-endian 0 and -32124, mu-law's loudest negative.
      payload: Buffer.from([0, 0, 0x84, 0x82])
    });
    expect(
      protocol.parse(text({ event: 'mark', mark: { name: 'm1' } }), false)
    ).toEqual({ kind: 'mark', marker: 'm1' });
    expect(protocol.parse(text({ event: 'clear' }), false)).toEqual({
      kind: 'clear'
    });
    expect(protocol.parse(text({ event: 'stop' }), false)).toBeNull();
    expect(protocol.parse(Buffer.from('not json'), false)).toBeNull();
    expect(protocol.parse(Buffer.from([1, 2]), true)).toBeNull();
  });
});

// §9.4 "WebSocket targets": the Vonage Voice API WebSocket.
describe('vonage', () => {
  it('opens with websocket:connected, its content type and the metadata as properties', () => {
    const frames = botProtocol('vonage').start({ ...START, sampleRate: 16000 });
    expect(frames.map(json)).toEqual([
      {
        event: 'websocket:connected',
        'content-type': 'audio/l16;rate=16000',
        ...START.parameters
      }
    ]);
  });

  it('passes little-endian PCM through both ways, a trailing odd byte dropped', () => {
    const protocol = botProtocol('vonage');
    expect(protocol.media(Buffer.from([0x34, 0x12]), 0)).toEqual(
      Buffer.from([0x34, 0x12])
    );
    expect(protocol.parse(Buffer.from([0x34, 0x12, 0x56]), true)).toEqual({
      kind: 'audio',
      payload: Buffer.from([0x34, 0x12])
    });
  });

  it('answers notify once played, clear with websocket:cleared, and sends DTMF with its duration', () => {
    const protocol = botProtocol('vonage');
    const text = (value: unknown): Buffer => Buffer.from(JSON.stringify(value));
    const notify = protocol.parse(
      text({ action: 'notify', payload: { step: 2 } }),
      false
    );
    expect(notify).toEqual({ kind: 'mark', marker: { step: 2 } });
    expect(json(protocol.marked({ step: 2 }))).toEqual({
      event: 'websocket:notify',
      payload: { step: 2 }
    });
    expect(protocol.parse(text({ action: 'clear' }), false)).toEqual({
      kind: 'clear'
    });
    expect(protocol.cleared([{ step: 3 }]).map(json)).toEqual([
      { event: 'websocket:cleared' }
    ]);
    expect(json(protocol.dtmf('#', 250))).toEqual({
      event: 'websocket:dtmf',
      digit: '#',
      duration: 250
    });
    expect(protocol.stop()).toBeNull();
  });
});
