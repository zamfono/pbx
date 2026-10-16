/**
 * G.711 μ-law (ITU-T G.711 §3, the 14-bit segment table as the reference C does it) for a
 * `twilio` bot (§9.4 "WebSocket targets"): AudioSocket carries only signed linear, Twilio Media
 * Streams only μ-law at 8 kHz. Each code is its sign, a 3-bit segment and a 4-bit step, inverted;
 * computed with arithmetic since the repo lints out bitwise operators.
 */
const BIAS = 0x84;
const CLIP = 32_635;
const SIGN = 0x80;
const SEGMENT_UNIT = 0x10;
const STEPS = 0x10;
const STEP_SHIFT = 3;
const SEGMENT_BASE = 7;
const ALL_ONES = 0xff;
const SAMPLE_BYTES = 2;
const CODES = 0x100;
const BINARY = 2;
// The bit `Math.clz32` counts down from.
const TOP_BIT = 31;

/** The linear sample of each code. */
const DECODED = Int16Array.from(Array(CODES).keys(), code => {
  const inverted = ALL_ONES - code;
  const segment = Math.floor((inverted % SIGN) / SEGMENT_UNIT);
  const magnitude =
    ((inverted % STEPS) * BINARY ** STEP_SHIFT + BIAS) * BINARY ** segment -
    BIAS;
  return inverted >= SIGN ? -magnitude : magnitude;
});

/** One linear sample's code. */
function encodeSample(sample: number): number {
  const sign = sample < 0 ? SIGN : 0;
  const biased = Math.min(Math.abs(sample), CLIP) + BIAS;
  // The position of the highest bit set: 7 to 14 for the biased range.
  const segment = TOP_BIT - Math.clz32(biased) - SEGMENT_BASE;
  const step = Math.floor(biased / BINARY ** (segment + STEP_SHIFT)) % STEPS;
  return ALL_ONES - (sign + segment * SEGMENT_UNIT + step);
}

/** Little-endian 16-bit linear as μ-law; a trailing odd byte, no whole sample, is dropped. */
export function linearToUlaw(linear: Buffer): Buffer {
  const codes = Buffer.alloc(Math.floor(linear.length / SAMPLE_BYTES));
  for (let index = 0; index < codes.length; index += 1) {
    codes[index] = encodeSample(linear.readInt16LE(index * SAMPLE_BYTES));
  }
  return codes;
}

/** μ-law as little-endian 16-bit linear. */
export function ulawToLinear(codes: Buffer): Buffer {
  const linear = Buffer.alloc(codes.length * SAMPLE_BYTES);
  codes.forEach((code, index) => {
    linear.writeInt16LE(DECODED[code] ?? 0, index * SAMPLE_BYTES);
  });
  return linear;
}
