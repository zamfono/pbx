import { now as demoNow } from '#lib/clock.svelte.js';

/**
 * Ids in the API's format, uuid v7 (§11.1): a millisecond timestamp prefix and random bits. The
 * seed derives stable ids from a name, so links and the audit log survive a reset.
 */

const HEX = 16;
const TIMESTAMP_DIGITS = 12;

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, byte => byte.toString(HEX).padStart(2, '0')).join(
    ''
  );
}

function format(timestampMs: number, random: string): string {
  const time = Math.floor(timestampMs)
    .toString(HEX)
    .padStart(TIMESTAMP_DIGITS, '0')
    .slice(-TIMESTAMP_DIGITS);
  return `${time.slice(0, 8)}-${time.slice(8, 12)}-7${random.slice(0, 3)}-${(
    (Number.parseInt(random.slice(3, 4), HEX) % 4) +
    8
  ).toString(HEX)}${random.slice(4, 7)}-${random.slice(7, 19)}`;
}

/** A fresh uuid v7. */
export function newId(now = demoNow()): string {
  const bytes = new Uint8Array(10);
  crypto.getRandomValues(bytes);
  return format(now, hex(bytes));
}

/** A stable uuid v7-shaped id for a seed row, derived from `name` (FNV-1a, stretched). */
export function seedId(
  name: string,
  timestampMs = Date.UTC(2026, 0, 12)
): string {
  let hash = 0x811c9dc5;
  let random = '';
  for (let round = 0; random.length < 20; round += 1) {
    for (const char of `${name}#${round}`) {
      hash ^= char.charCodeAt(0);
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    random += hash.toString(HEX).padStart(8, '0');
  }
  return format(timestampMs + (hash % 86_400_000), random);
}
