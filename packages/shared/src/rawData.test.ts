import { describe, expect, it } from 'vitest';

import { rawDataToString } from './rawData.js';

describe('rawDataToString', () => {
  it('reads a Buffer', () => {
    expect(rawDataToString(Buffer.from('grüß', 'utf8'))).toBe('grüß');
  });

  it('reads an ArrayBuffer', () => {
    const bytes = new TextEncoder().encode('{"a":1}');
    const buffer = new ArrayBuffer(bytes.byteLength);
    new Uint8Array(buffer).set(bytes);
    expect(rawDataToString(buffer)).toBe('{"a":1}');
  });

  it('joins fragmented Buffers', () => {
    expect(
      rawDataToString([Buffer.from('he', 'utf8'), Buffer.from('llo', 'utf8')])
    ).toBe('hello');
  });
});
