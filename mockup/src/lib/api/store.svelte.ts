/**
 * The mock tenant: one reactive `Db` every screen reads and only the operations layer writes.
 * It persists in localStorage so a reload keeps the demo where it was; *Reset demo* restores the
 * seed. Storage may be unavailable (private windows, blocked site data), so every access is
 * guarded and the mockup runs from memory then.
 */
import { seed } from './seed';
import type { Db } from './types';

const STORAGE_KEY = 'zamfono-mockup:db:v4';
const SAVE_DELAY_MS = 400;

function load(): Db {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw !== null) {
      return JSON.parse(raw) as Db;
    }
  } catch {
    // Storage blocked or the stored state unreadable: start from the seed.
  }
  return seed();
}

export const store = $state<{ db: Db; revision: number }>({
  db: load(),
  revision: 0
});

/** A plain, non-reactive deep copy of a value read from the store. */
export function snap<T>(value: T): T {
  return $state.snapshot(value) as T;
}

let saveTimer: ReturnType<typeof setTimeout> | undefined;

/** Called by the operations layer after every write; saves debounced. */
export function touch(): void {
  store.revision += 1;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify($state.snapshot(store.db))
      );
    } catch {
      // Storage full or blocked: the demo keeps running from memory.
    }
  }, SAVE_DELAY_MS);
}

// Several tabs show one tenant (e.g. two personas side by side): a save in another tab replaces
// this tab's copy, so their changes meet instead of overwriting each other.
if (typeof window !== 'undefined') {
  window.addEventListener('storage', event => {
    if (event.key === STORAGE_KEY && event.newValue !== null) {
      try {
        store.db = JSON.parse(event.newValue) as Db;
        store.revision += 1;
      } catch {
        // A half-written value: the next save brings the tab back in line.
      }
    }
  });
}

export function resetDb(): void {
  store.db = seed();
  touch();
}
