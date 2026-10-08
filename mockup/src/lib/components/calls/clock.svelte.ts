/**
 * A ticking clock for live durations: reading `nowMs()` in a template or `$derived` re-runs it
 * every second while anything reads it, and the interval stops when nothing does.
 */
import { createSubscriber } from 'svelte/reactivity';

import { now as demoNow } from '#lib/clock.svelte.js';

const TICK_MS = 1000;

const subscribe = createSubscriber(update => {
  const timer = setInterval(update, TICK_MS);
  return () => clearInterval(timer);
});

export function nowMs(): number {
  subscribe();
  return demoNow();
}

/** Whole seconds since `iso`, ticking. */
export function secondsSince(iso: string): number {
  return Math.max(0, Math.floor((nowMs() - Date.parse(iso)) / 1000));
}
