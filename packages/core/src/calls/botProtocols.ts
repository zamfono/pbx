/**
 * The two wire protocols a `webSocket` target speaks (§9.4 "WebSocket targets"): Twilio Media
 * Streams, bidirectional as `<Connect><Stream>` runs it, and the Vonage Voice API WebSocket. Each
 * turns what the call does into the frames the bot receives, and a frame the bot sends into a
 * command, the audio on `core`'s side signed linear little-endian, as AudioSocket carries it
 * (`botAudioSocket.ts`): μ-law on the wire for `twilio`, the same linear for `vonage`.
 */
import { isRecord, newId, type WebSocketProtocol } from '@zamfono/shared';

import { linearToUlaw, ulawToLinear } from './ulaw.js';

/** What the bot is told when the stream starts: the call, the stream's own id, and the values
 * the target's metadata carries (`botMetadata`). */
export type BotStart = {
  callId: string;
  accountId: string;
  sampleRate: number;
  parameters: Record<string, string>;
};

/** What a frame from the bot asks for: audio to play, a marker to echo once the audio queued
 * before it has played, or the queued audio dropped. */
export type BotCommand =
  | { kind: 'audio'; payload: Buffer }
  | { kind: 'mark'; marker: unknown }
  | { kind: 'clear' };

/** A frame the stack sends the bot: text or binary. */
export type BotFrame = string | Buffer;

export type BotProtocol = {
  /** The frames sent once the socket is open. */
  start(info: BotStart): BotFrame[];
  /** One frame of the caller's audio, `elapsedMs` into the stream. */
  media(payload: Buffer, elapsedMs: number): BotFrame;
  dtmf(digit: string, durationMs: number): BotFrame;
  /** A marker the audio before it has played. */
  marked(marker: unknown): BotFrame;
  /** The queued audio was dropped on the bot's `clear`; `pending` the markers dropped with it. */
  cleared(pending: unknown[]): BotFrame[];
  /** The frame sent as the call ends, before the socket closes, if any. */
  stop(): BotFrame | null;
  /** The command a frame from the bot carries, `null` for one the protocol ignores. */
  parse(data: Buffer, isBinary: boolean): BotCommand | null;
};

const SAMPLE_BYTES = 2;

/** `data` without a trailing odd byte, no whole sample, which would shift every later one. */
export function wholeSamples(data: Buffer): Buffer {
  return data.subarray(0, data.length - (data.length % SAMPLE_BYTES));
}

/** A JSON text frame's object, `null` for anything else. */
function parseJson(
  data: Buffer,
  isBinary: boolean
): Record<string, unknown> | null {
  if (isBinary) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(data.toString('utf8'));
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** The command a frame from a Twilio bot carries: `media`, `mark` or `clear`. */
function parseTwilio(data: Buffer, isBinary: boolean): BotCommand | null {
  const message = parseJson(data, isBinary);
  if (message?.event === 'clear') {
    return { kind: 'clear' };
  }
  const body = message?.[String(message.event)];
  if (!isRecord(body)) {
    return null;
  }
  if (message?.event === 'media' && typeof body.payload === 'string') {
    return {
      kind: 'audio',
      payload: ulawToLinear(Buffer.from(body.payload, 'base64'))
    };
  }
  if (message?.event === 'mark' && typeof body.name === 'string') {
    return { kind: 'mark', marker: body.name };
  }
  return null;
}

/**
 * Twilio Media Streams (https://www.twilio.com/docs/voice/media-streams/websocket-messages):
 * `connected`, `start`, then `media` with base64 μ-law, `dtmf`, the echoed `mark`s and `stop`,
 * each numbered by `sequenceNumber`; the bot sends `media`, `mark` and `clear`. `callSid` is the
 * stack's own call id, which the stack's API acts on (§10.3 "Live calls").
 */
function twilioProtocol(): BotProtocol {
  const streamSid = `MZ${newId()}`;
  let sequence = 0;
  let chunk = 0;
  let callSid = '';
  let accountSid = '';
  const frame = (event: string, body: Record<string, unknown>): string => {
    sequence += 1;
    return JSON.stringify({
      event,
      sequenceNumber: String(sequence),
      ...body,
      streamSid
    });
  };
  const markFrame = (marker: unknown): string =>
    frame('mark', { mark: { name: String(marker) } });
  return {
    start: info => {
      callSid = info.callId;
      accountSid = info.accountId;
      return [
        JSON.stringify({
          event: 'connected',
          protocol: 'Call',
          version: '1.0.0'
        }),
        frame('start', {
          start: {
            accountSid,
            streamSid,
            callSid,
            tracks: ['inbound'],
            customParameters: info.parameters,
            mediaFormat: {
              encoding: 'audio/x-mulaw',
              sampleRate: info.sampleRate,
              channels: 1
            }
          }
        })
      ];
    },
    media: (payload, elapsedMs) => {
      chunk += 1;
      return frame('media', {
        media: {
          track: 'inbound',
          chunk: String(chunk),
          timestamp: String(elapsedMs),
          payload: linearToUlaw(payload).toString('base64')
        }
      });
    },
    dtmf: digit => frame('dtmf', { dtmf: { track: 'inbound_track', digit } }),
    marked: markFrame,
    // Twilio answers a `clear` with the marks of the audio it dropped.
    cleared: pending => pending.map(markFrame),
    stop: () => frame('stop', { stop: { accountSid, callSid } }),
    parse: parseTwilio
  };
}

/**
 * The Vonage Voice API WebSocket
 * (https://developer.vonage.com/en/voice/voice-api/concepts/websockets): `websocket:connected`
 * with the content type and the target's metadata as its properties, then binary 16-bit
 * little-endian PCM, and `websocket:dtmf`; the bot sends binary PCM, `{"action":"clear"}`,
 * answered `websocket:cleared`, and `{"action":"notify","payload":…}`, answered
 * `websocket:notify` with the payload once the audio before it has played.
 */
function vonageProtocol(): BotProtocol {
  return {
    start: info => [
      JSON.stringify({
        ...info.parameters,
        event: 'websocket:connected',
        'content-type': `audio/l16;rate=${String(info.sampleRate)}`
      })
    ],
    media: payload => payload,
    dtmf: (digit, durationMs) =>
      JSON.stringify({ event: 'websocket:dtmf', digit, duration: durationMs }),
    marked: marker =>
      JSON.stringify({ event: 'websocket:notify', payload: marker }),
    cleared: () => [JSON.stringify({ event: 'websocket:cleared' })],
    stop: () => null,
    parse: (data, isBinary) => {
      if (isBinary) {
        return { kind: 'audio', payload: wholeSamples(data) };
      }
      const message = parseJson(data, isBinary);
      if (message?.action === 'clear') {
        return { kind: 'clear' };
      }
      if (message?.action === 'notify') {
        return { kind: 'mark', marker: message.payload ?? null };
      }
      return null;
    }
  };
}

/** A fresh protocol state for one stream. */
export function botProtocol(protocol: WebSocketProtocol): BotProtocol {
  return protocol === 'twilio' ? twilioProtocol() : vonageProtocol();
}
