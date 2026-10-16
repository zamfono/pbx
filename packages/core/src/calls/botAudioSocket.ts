/**
 * The AudioSocket stream a voice bot's media channel carries (§9.4 "WebSocket targets"):
 * Asterisk's `chan_audiosocket` connects to a TCP server of `core`'s, names the channel by its
 * UUID, then sends and takes signed linear audio, little-endian, at the channel's rate. Each
 * message is a kind byte, a big-endian 16-bit length and that many bytes (`res_audiosocket.h`).
 */
import {
  NARROWBAND_SAMPLE_RATE,
  SUPER_WIDEBAND_SAMPLE_RATE,
  WIDEBAND_SAMPLE_RATE,
  type WebSocketSampleRate
} from '@zamfono/shared';

import { FRAME_MS } from './botPlayout.js';

const HEADER_BYTES = 3;
const LENGTH_OFFSET = 1;
/** The message kinds `core` reads: the connection's UUID, and audio at each of the rates. */
export const UUID_KIND = 0x01;
// Audio from 8 kHz (0x10) to 192 kHz (0x18) signed linear.
const FIRST_AUDIO_KIND = 0x10;
const LAST_AUDIO_KIND = 0x18;

/** The media channel's encoding at a target's rate: Asterisk's format, the AudioSocket kind
 * its audio travels as, and the bytes of one 20 ms frame. */
export type MediaEncoding = {
  format: 'slin' | 'slin16' | 'slin24';
  kind: number;
  frameBytes: number;
};

const LINEAR_SAMPLE_BYTES = 2;
const MS_PER_SECOND = 1000;
const ENCODINGS = new Map<number, Pick<MediaEncoding, 'format' | 'kind'>>([
  [NARROWBAND_SAMPLE_RATE, { format: 'slin', kind: 0x10 }],
  [WIDEBAND_SAMPLE_RATE, { format: 'slin16', kind: 0x12 }],
  [SUPER_WIDEBAND_SAMPLE_RATE, { format: 'slin24', kind: 0x13 }]
]);

/** The media channel's encoding at `sampleRate`. */
export function mediaEncoding(sampleRate: WebSocketSampleRate): MediaEncoding {
  const encoding = ENCODINGS.get(sampleRate);
  if (encoding === undefined) {
    throw new Error(`no linear encoding at ${String(sampleRate)} Hz`);
  }
  return {
    ...encoding,
    frameBytes: ((sampleRate * FRAME_MS) / MS_PER_SECOND) * LINEAR_SAMPLE_BYTES
  };
}

/** One AudioSocket message. */
export function audioSocketMessage(kind: number, payload: Buffer): Buffer {
  const header = Buffer.alloc(HEADER_BYTES);
  header.writeUInt8(kind, 0);
  header.writeUInt16BE(payload.length, LENGTH_OFFSET);
  return Buffer.concat([header, payload]);
}

/** The 16 bytes a UUID's message carries. */
export function uuidBytes(uuid: string): Buffer {
  return Buffer.from(uuid.replaceAll('-', ''), 'hex');
}

export type AudioSocketMessage = { kind: number; payload: Buffer };

/** Splits the TCP stream into messages, however it arrives. */
export class AudioSocketReader {
  private pending: Buffer = Buffer.alloc(0);

  /** The whole messages `chunk` completes; a partial one waits for the next. */
  push(chunk: Buffer): AudioSocketMessage[] {
    this.pending =
      this.pending.length === 0 ? chunk : Buffer.concat([this.pending, chunk]);
    const messages: AudioSocketMessage[] = [];
    while (this.pending.length >= HEADER_BYTES) {
      const end = HEADER_BYTES + this.pending.readUInt16BE(LENGTH_OFFSET);
      if (this.pending.length < end) {
        break;
      }
      messages.push({
        kind: this.pending.readUInt8(0),
        payload: this.pending.subarray(HEADER_BYTES, end)
      });
      this.pending = this.pending.subarray(end);
    }
    return messages;
  }

  /** What arrived after the last whole message. */
  rest(): Buffer {
    return this.pending;
  }
}

/** Whether `message` carries audio; the caller's DTMF comes over ARI instead. */
export function isAudio(message: AudioSocketMessage): boolean {
  return message.kind >= FIRST_AUDIO_KIND && message.kind <= LAST_AUDIO_KIND;
}
