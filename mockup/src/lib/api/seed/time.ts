import { now as demoNow } from '#lib/clock.svelte.js';

/**
 * Seed times relative to the moment the seed is built, in the tenant's time zone, so the demo
 * always shows today's calls and this week's history whenever it is opened.
 */

const TIME_ZONE = 'Europe/Berlin';
const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;

/** Minutes the tenant's zone is ahead of UTC at `date`. */
function zoneOffsetMinutes(date: Date): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: TIME_ZONE,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  }).formatToParts(date);
  const get = (type: string): number =>
    Number(parts.find(part => part.type === type)?.value ?? 0);
  const asUtc = Date.UTC(
    get('year'),
    get('month') - 1,
    get('day'),
    get('hour'),
    get('minute')
  );
  return Math.round((asUtc - date.getTime()) / MINUTE_MS);
}

/** The tenant-local calendar date `daysBack` days before today, as [year, month, day]. */
function localDate(daysBack: number): [number, number, number] {
  const shifted = new Date(demoNow() - daysBack * DAY_MS);
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: TIME_ZONE,
    year: 'numeric',
    month: 'numeric',
    day: 'numeric'
  }).formatToParts(shifted);
  const get = (type: string): number =>
    Number(parts.find(part => part.type === type)?.value ?? 0);
  return [get('year'), get('month'), get('day')];
}

/** ISO instant of tenant-local `hour:minute` on the day `daysBack` days ago. */
export function at(
  daysBack: number,
  hour: number,
  minute = 0,
  second = 0
): string {
  const [year, month, day] = localDate(daysBack);
  const guess = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  const offset = zoneOffsetMinutes(guess);
  return new Date(guess.getTime() - offset * MINUTE_MS).toISOString();
}

/** ISO instant `days` days before now (negative: in the future). */
export function daysAgo(days: number): string {
  return new Date(demoNow() - days * DAY_MS).toISOString();
}

/** ISO instant `minutes` minutes before now. */
export function minutesAgo(minutes: number): string {
  return new Date(demoNow() - minutes * MINUTE_MS).toISOString();
}

/** ISO instant offset by `seconds` from `iso`. */
export function plus(iso: string, seconds: number): string {
  return new Date(new Date(iso).getTime() + seconds * 1000).toISOString();
}

/** Weekday 1 (Monday) … 7 of the tenant-local day `daysBack` days ago. */
export function weekdayOf(daysBack: number): number {
  const [year, month, day] = localDate(daysBack);
  const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  return weekday === 0 ? 7 : weekday;
}

/** The tenant-local date `daysBack` days ago, ISO calendar date. */
export function dateOf(daysBack: number): string {
  const [year, month, day] = localDate(daysBack);
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/** A small deterministic PRNG (mulberry32), so the generated history is the same on every reset. */
export function prng(seedValue: number): () => number {
  let state = seedValue >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let mixed = state;
    mixed = Math.imul(mixed ^ (mixed >>> 15), mixed | 1);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4_294_967_296;
  };
}
