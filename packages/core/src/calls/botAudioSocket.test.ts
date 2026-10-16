import { describe, expect, it } from 'vitest';

import {
  audioSocketMessage,
  AudioSocketReader,
  isAudio,
  mediaEncoding
} from './botAudioSocket.js';

// §9.4 "WebSocket targets": the AudioSocket stream of a voice bot's media channel, as Asterisk
// 22's res_audiosocket.h frames it.
describe('mediaEncoding', () => {
  it.each([
    [8000, { format: 'slin', kind: 0x10, frameBytes: 320 }],
    [16_000, { format: 'slin16', kind: 0x12, frameBytes: 640 }],
    [24_000, { format: 'slin24', kind: 0x13, frameBytes: 960 }]
  ] as const)(
    'at %i Hz is %o, a 20 ms frame of 16-bit samples',
    (rate, expected) => {
      expect(mediaEncoding(rate)).toEqual(expected);
    }
  );
});

describe('AudioSocketReader', () => {
  it('splits the stream into messages however it arrives, a partial one waiting', () => {
    const stream = Buffer.concat([
      audioSocketMessage(0x01, Buffer.alloc(16, 0xab)),
      audioSocketMessage(0x12, Buffer.from([1, 2, 3, 4])),
      audioSocketMessage(0x03, Buffer.from('5'))
    ]);
    const reader = new AudioSocketReader();
    expect(reader.push(stream.subarray(0, 2))).toEqual([]);
    expect(reader.push(stream.subarray(2, 28))).toEqual([
      { kind: 0x01, payload: Buffer.alloc(16, 0xab) },
      { kind: 0x12, payload: Buffer.from([1, 2, 3, 4]) }
    ]);
    expect(reader.rest()).toEqual(stream.subarray(26, 28));
    expect(reader.push(stream.subarray(28))).toEqual([
      { kind: 0x03, payload: Buffer.from('5') }
    ]);
    expect(reader.rest()).toHaveLength(0);
  });

  it('writes the length big-endian, and tells audio from the other kinds', () => {
    expect(audioSocketMessage(0x10, Buffer.alloc(320)).subarray(0, 3)).toEqual(
      Buffer.from([0x10, 0x01, 0x40])
    );
    expect(isAudio({ kind: 0x10, payload: Buffer.alloc(0) })).toBe(true);
    expect(isAudio({ kind: 0x18, payload: Buffer.alloc(0) })).toBe(true);
    expect(isAudio({ kind: 0x03, payload: Buffer.alloc(0) })).toBe(false);
    expect(isAudio({ kind: 0x00, payload: Buffer.alloc(0) })).toBe(false);
  });
});
