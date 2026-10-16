import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocketServer, type WebSocket } from 'ws';

import { newId, nowIso, type Db } from '@zamfono/shared';
import { seedDid } from '@zamfono/shared/testDb.js';

import type { Channel } from '../ari/types.js';
import type { ForwardTarget } from '../routing/targets.js';
import type { FakeAri } from '../testing/ari/fake.js';
import { eventually } from '../testing/eventually.js';
import { startRig, type Rig } from '../testing/pipelineRig.js';
import {
  audioSocketMessage,
  AudioSocketReader,
  type AudioSocketMessage
} from './botAudioSocket.js';
import { sessionTokenHash } from './botSession.js';
import { newCall, type Call } from './call.js';
import { enterTarget } from './inbound.js';
import type { Pipeline } from './pipeline.js';

// §9.4 "WebSocket targets", §10.1 step 7: the call handed to a voice bot over a WebSocket, its
// audio streamed over AudioSocket through an `externalMedia` channel, which the bot's leg is.

const CALLER = '+15559999';
const CALLED = '+15551077';
// One 20 ms frame of 8 kHz linear.
const FRAME_BYTES = 320;
const SLIN_KIND = 0x10;
const SLIN16_KIND = 0x12;

/** A voice bot: a WebSocket server keeping every frame it receives, text parsed. */
class FakeBot {
  readonly server: WebSocketServer;
  readonly received: (Record<string, unknown> | Buffer)[] = [];
  socket: WebSocket | null = null;
  closed = false;

  constructor() {
    this.server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
    this.server.on('connection', socket => {
      this.socket = socket;
      socket.on('message', (data, isBinary) => {
        const buffer = data as Buffer;
        this.received.push(
          isBinary
            ? buffer
            : (JSON.parse(buffer.toString()) as Record<string, unknown>)
        );
      });
      socket.on('close', () => {
        this.closed = true;
      });
    });
  }

  get url(): string {
    return `ws://127.0.0.1:${String((this.server.address() as AddressInfo).port)}/bot`;
  }

  events(name: string): Record<string, unknown>[] {
    return this.received.filter(
      (frame): frame is Record<string, unknown> =>
        !Buffer.isBuffer(frame) && frame.event === name
    );
  }

  /** Stops listening, cutting off a stream still open. */
  close(): Promise<void> {
    for (const client of this.server.clients) {
      client.terminate();
    }
    return new Promise(resolve => {
      this.server.close(() => {
        resolve();
      });
    });
  }
}

describe('webSocket targets (§9.4 "WebSocket targets")', () => {
  let rig: Rig;
  let db: Db;
  let fakeAri: FakeAri;
  let pipeline: Pipeline;
  let callerChannel: Channel;
  let bot: FakeBot;
  // What `core` sent Asterisk over the media channel's AudioSocket.
  const fromCore: AudioSocketMessage[] = [];

  /** Asterisk's end of the media channel's AudioSocket, read into `fromCore`. */
  async function asterisk(): Promise<{ write: (data: Buffer) => void }> {
    const socket = await eventually(() => {
      const [first] = fakeAri.externalMediaSockets;
      expect(first).toBeDefined();
      return first;
    });
    const reader = new AudioSocketReader();
    socket?.on('data', (chunk: Buffer) => fromCore.push(...reader.push(chunk)));
    return { write: data => socket?.write(data) };
  }

  function inboundCall(): Call {
    const call = newCall({
      id: newId(),
      direction: 'inbound',
      callerChannelId: callerChannel.id,
      from: CALLER,
      to: CALLED,
      startedAt: nowIso(),
      logLevel: 'events',
      callLogMaxBytes: 1_048_576
    });
    pipeline.registerCall(call);
    return call;
  }

  function target(
    fields: Partial<Extract<ForwardTarget, { kind: 'webSocket' }>> = {}
  ): ForwardTarget {
    return {
      kind: 'webSocket',
      protocol: 'twilio',
      url: fields.url ?? bot.url,
      sampleRate: 8000,
      ...fields
    };
  }

  function traceEvents(call: Call): Record<string, unknown>[] {
    return (call.log.finish().log ?? '')
      .split('\n')
      .filter(line => line !== '')
      .map(line => JSON.parse(line) as Record<string, unknown>);
  }

  beforeEach(async () => {
    fromCore.length = 0;
    bot = new FakeBot();
    rig = await startRig();
    ({ db, fakeAri, pipeline } = rig);
    fakeAri.reportsHangups = true;
    await db
      .updateTable('settings')
      .set({ mainDidId: await seedDid(db, '+15551000') })
      .execute();
    callerChannel = fakeAri.addChannel({
      caller: { number: CALLER, name: '' }
    });
  });

  afterEach(async () => {
    if (bot.server.address() !== null) {
      await bot.close();
    }
    await rig.stop();
  });

  it('answers with the bot, which gets connected, start and the caller as base64 mu-law, and plays what it sends', async () => {
    const call = inboundCall();
    await enterTarget(pipeline, call, target(), null);

    const start = await eventually(() => {
      const [frame] = bot.events('start');
      expect(frame).toBeDefined();
      return frame?.start as Record<string, unknown>;
    });
    expect(bot.events('connected')).toHaveLength(1);
    const leg = [...call.legs.values()].find(
      entry => entry.kind === 'webSocket'
    );
    expect(call.answeredAt).not.toBeNull();
    expect(start).toMatchObject({
      callSid: call.id,
      tracks: ['inbound'],
      mediaFormat: { encoding: 'audio/x-mulaw', sampleRate: 8000, channels: 1 },
      customParameters: {
        callerNumber: CALLER,
        did: CALLED,
        callId: call.id,
        direction: 'inbound',
        callerLegId: call.callerLegId,
        botLegId: leg?.id,
        apiUrl: 'https://pbx.example.com/api/v1'
      }
    });
    const externalMedia = fakeAri.calls.find(
      entry => entry.path === 'channels/externalMedia'
    );
    expect(externalMedia?.body).toMatchObject({
      app: 'zamfono',
      format: 'slin',
      encapsulation: 'audiosocket',
      transport: 'tcp',
      data: leg?.channelId
    });

    // The caller's audio reaches the bot as mu-law; a DTMF message does not.
    const media = await asterisk();
    media.write(audioSocketMessage(0x03, Buffer.from('5')));
    media.write(audioSocketMessage(SLIN_KIND, Buffer.alloc(FRAME_BYTES)));
    await eventually(() => {
      expect(bot.events('media')).toHaveLength(1);
    });
    expect(bot.events('media')[0]).toMatchObject({
      media: {
        track: 'inbound',
        chunk: '1',
        payload: Buffer.alloc(FRAME_BYTES / 2, 0xff).toString('base64')
      }
    });

    // The bot's mu-law reaches Asterisk as two frames of linear, then its mark is echoed.
    const spoken = Buffer.alloc(FRAME_BYTES, 0xff);
    bot.socket?.send(
      JSON.stringify({
        event: 'media',
        streamSid: start.streamSid,
        media: { payload: spoken.toString('base64') }
      })
    );
    bot.socket?.send(
      JSON.stringify({
        event: 'mark',
        streamSid: start.streamSid,
        mark: { name: 'greeting' }
      })
    );
    await eventually(() => {
      expect(bot.events('mark')).toMatchObject([
        { mark: { name: 'greeting' } }
      ]);
    });
    await eventually(() => {
      expect(fromCore).toEqual([
        { kind: SLIN_KIND, payload: Buffer.alloc(FRAME_BYTES) },
        { kind: SLIN_KIND, payload: Buffer.alloc(FRAME_BYTES) }
      ]);
    });
  });

  it('hands the caller’s DTMF to the bot and its session token resolves while the stream lasts', async () => {
    const call = inboundCall();
    await enterTarget(pipeline, call, target(), null);
    const start = await eventually(() => {
      const [frame] = bot.events('start');
      expect(frame).toBeDefined();
      return frame?.start as { customParameters: Record<string, string> };
    });
    const { sessionToken, botLegId } = start.customParameters;
    expect(sessionToken).toMatch(/^zcs_[A-Za-z0-9_-]{43}$/u);
    const hash = sessionTokenHash(sessionToken ?? '');
    expect(pipeline.deps.bots.resolve(hash)).toEqual({
      callId: call.id,
      legId: botLegId
    });

    fakeAri.emit({
      type: 'ChannelDtmfReceived',
      timestamp: nowIso(),
      application: 'zamfono',
      channel: callerChannel,
      digit: '7',
      duration_ms: 160
    });
    await eventually(() => {
      expect(bot.events('dtmf')).toMatchObject([{ dtmf: { digit: '7' } }]);
    });

    // The caller hangs up: the bot gets `stop`, its socket closes and the token no longer works.
    fakeAri.hangUpRemotely(callerChannel.id);
    await eventually(() => {
      expect(bot.closed).toBe(true);
    });
    expect(bot.events('stop')).toHaveLength(1);
    expect(pipeline.deps.bots.resolve(hash)).toBeNull();
  });

  it('ends the call when the bot closes its socket', async () => {
    const call = inboundCall();
    await enterTarget(pipeline, call, target(), null);
    await eventually(() => {
      expect(bot.events('start')).toHaveLength(1);
    });
    const leg = [...call.legs.values()].find(
      entry => entry.kind === 'webSocket'
    );
    bot.socket?.close();
    await eventually(() => {
      expect(rig.hungUp(leg?.channelId ?? '')).toBe(true);
      expect(rig.hungUp(callerChannel.id)).toBe(true);
    });
  });

  it('releases the call with 503 when the socket does not open', async () => {
    const url = bot.url;
    await bot.close();
    const call = inboundCall();
    await enterTarget(pipeline, call, target({ url }), null);
    expect(traceEvents(call)).toContainEqual(
      expect.objectContaining({
        event: 'webSocket',
        protocol: 'twilio',
        cause: 'connectFailed'
      })
    );
    expect(traceEvents(call)).toContainEqual(
      expect.objectContaining({ event: 'release', code: 503 })
    );
    expect(
      fakeAri.calls.some(entry => entry.path === 'channels/externalMedia')
    ).toBe(false);
  });

  it('streams a vonage target as little-endian PCM at its rate', async () => {
    const call = inboundCall();
    await enterTarget(
      pipeline,
      call,
      target({ protocol: 'vonage', sampleRate: 16000 }),
      null
    );
    await eventually(() => {
      expect(bot.events('websocket:connected')).toMatchObject([
        { 'content-type': 'audio/l16;rate=16000', callerNumber: CALLER }
      ]);
    });
    expect(
      fakeAri.calls.find(entry => entry.path === 'channels/externalMedia')?.body
    ).toMatchObject({ format: 'slin16' });

    const media = await asterisk();
    media.write(audioSocketMessage(SLIN16_KIND, Buffer.from([0x34, 0x12])));
    await eventually(() => {
      expect(bot.received.filter(frame => Buffer.isBuffer(frame))).toEqual([
        Buffer.from([0x34, 0x12])
      ]);
    });

    bot.socket?.send(Buffer.from([0x78, 0x56]));
    bot.socket?.send(
      JSON.stringify({ action: 'notify', payload: { step: 1 } })
    );
    await eventually(() => {
      expect(bot.events('websocket:notify')).toEqual([
        { event: 'websocket:notify', payload: { step: 1 } }
      ]);
    });
    // One 20 ms frame at 16 kHz, the bot's sample first, as it came, then silence.
    expect(fromCore.at(0)).toEqual({
      kind: SLIN16_KIND,
      payload: Buffer.concat([Buffer.from([0x78, 0x56]), Buffer.alloc(638)])
    });
  });
});
