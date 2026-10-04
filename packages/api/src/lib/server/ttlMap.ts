// The map is swept for expired entries only once it grows past this size, since an entry nobody
// reads again would otherwise sit until it is looked up.
const SWEEP_THRESHOLD = 1000;

/**
 * An in-memory map whose entries expire at a time of their own: a read at or past it misses, and
 * expired entries are swept once the map grows past `SWEEP_THRESHOLD`. With `maxEntries`, setting
 * a new key into a full map first drops the entry set longest ago. It lives only in this
 * process's memory, so an `api` restart clears it.
 */
export class TtlMap<K, V> {
  readonly #now: () => number;
  readonly #maxEntries: number;
  readonly #entries = new Map<K, { value: V; expiresAtMs: number }>();

  constructor(now: () => number = () => Date.now(), maxEntries = Infinity) {
    this.#now = now;
    this.#maxEntries = maxEntries;
  }

  /** `key`'s value while it has not expired, else `undefined`. */
  get(key: K): V | undefined {
    const entry = this.#entries.get(key);
    return entry && entry.expiresAtMs > this.#now() ? entry.value : undefined;
  }

  /** Sets `key` to `value` until `expiresAtMs`. */
  set(key: K, value: V, expiresAtMs: number): void {
    const nowMs = this.#now();
    if (this.#entries.size > SWEEP_THRESHOLD) {
      for (const [entryKey, entry] of this.#entries) {
        if (entry.expiresAtMs <= nowMs) {
          this.#entries.delete(entryKey);
        }
      }
    }
    // A Map iterates in insertion order: re-inserting moves `key` last, so the first key is the
    // one set longest ago.
    this.#entries.delete(key);
    if (this.#entries.size >= this.#maxEntries) {
      const oldest = this.#entries.keys().next();
      if (oldest.done !== true) {
        this.#entries.delete(oldest.value);
      }
    }
    this.#entries.set(key, { value, expiresAtMs });
  }

  delete(key: K): void {
    this.#entries.delete(key);
  }
}
