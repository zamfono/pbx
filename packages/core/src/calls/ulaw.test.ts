import { describe, expect, it } from 'vitest';

import { linearToUlaw, ulawToLinear } from './ulaw.js';

/** Little-endian 16-bit samples. */
function linear(...samples: number[]): Buffer {
  const buffer = Buffer.alloc(samples.length * 2);
  samples.forEach((sample, index) => {
    buffer.writeInt16LE(sample, index * 2);
  });
  return buffer;
}

// §9.4 "WebSocket targets": a twilio bot's μ-law, as G.711's reference tables have it.
describe('G.711 mu-law', () => {
  it('codes the reference points', () => {
    expect(linearToUlaw(linear(0, -1, 32_767, -32_768, 1000))).toEqual(
      Buffer.from([0xff, 0x7f, 0x80, 0x00, 0xce])
    );
    expect(ulawToLinear(Buffer.from([0xff, 0x80, 0x00, 0xce]))).toEqual(
      linear(0, 32_124, -32_124, 988)
    );
  });

  it('decodes and encodes every code back to itself', () => {
    const codes = Buffer.from([...Array(256).keys()]);
    const back = linearToUlaw(ulawToLinear(codes));
    // 0x7f, negative zero, comes back as 0xff, positive zero.
    expect([...back]).toEqual(
      [...codes].map(code => (code === 0x7f ? 0xff : code))
    );
  });
});
