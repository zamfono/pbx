/**
 * The demo clock. Every reading of "now" in the mockup goes through `now()`, so the demo can run at
 * a chosen moment: an office morning, the evening after closing, the holidays, a colleague's
 * vacation. A moment is an offset from the real clock; time keeps running from there.
 *
 * Choosing a moment restarts the demo (`resetDemo`), because the seed builds the call history, the
 * voicemails and the backups relative to `now()`: a fresh seed is consistent with the moment, a
 * clock moved under a running demo would not be. Planned events (the holiday closure, Felix's
 * vacation) are anchored on the real calendar (`realNow()`), so the moments that show them find
 * them in effect.
 */

const STORAGE_KEY = 'zamfono-mockup:clock:v1';
const TIME_ZONE = 'Europe/Berlin';
const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;

export const MOMENTS = [
  'now',
  'officeDay',
  'evening',
  'holidays',
  'vacation'
] as const;
export type Moment = (typeof MOMENTS)[number];

type ClockState = { moment: Moment; offsetMs: number };

function load(): ClockState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw !== null) {
      const parsed = JSON.parse(raw) as Partial<ClockState>;
      if (
        MOMENTS.includes(parsed.moment as Moment) &&
        typeof parsed.offsetMs === 'number'
      ) {
        return { moment: parsed.moment as Moment, offsetMs: parsed.offsetMs };
      }
    }
  } catch {
    // Storage blocked: the real time.
  }
  return { moment: 'now', offsetMs: 0 };
}

export const clock = $state<ClockState>(load());

function save(): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify($state.snapshot(clock)));
  } catch {
    // Storage blocked: the moment lasts for this page load.
  }
}

// Another tab chose a moment: follow it (its demo data arrives through the store's own sync).
if (typeof window !== 'undefined') {
  window.addEventListener('storage', event => {
    if (event.key === STORAGE_KEY && event.newValue !== null) {
      try {
        const next = JSON.parse(event.newValue) as ClockState;
        clock.moment = next.moment;
        clock.offsetMs = next.offsetMs;
      } catch {
        // A half-written value: ignore.
      }
    }
  });
}

/** Milliseconds since the epoch at the demo's current moment. */
export function now(): number {
  return Date.now() + clock.offsetMs;
}

export const nowDate = (): Date => new Date(now());
export const nowIso = (): string => nowDate().toISOString();

/** The real time, for anchoring planned events on the real calendar. */
export const realNow = (): number => Date.now();

/** Minutes the tenant's zone is ahead of UTC at instant `ms`. */
function zoneOffsetMinutes(ms: number): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: TIME_ZONE,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  }).formatToParts(new Date(ms));
  const get = (type: string): number =>
    Number(parts.find(part => part.type === type)?.value ?? 0);
  const asUtc = Date.UTC(
    get('year'),
    get('month') - 1,
    get('day'),
    get('hour'),
    get('minute')
  );
  return Math.round((asUtc - ms) / MINUTE_MS);
}

/** The tenant-local calendar date of instant `ms`: [year, month, day, weekday 1–7]. */
export function localDate(ms: number): [number, number, number, number] {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: TIME_ZONE,
    year: 'numeric',
    month: 'numeric',
    day: 'numeric'
  }).formatToParts(new Date(ms));
  const get = (type: string): number =>
    Number(parts.find(part => part.type === type)?.value ?? 0);
  const [year, month, day] = [get('year'), get('month'), get('day')];
  const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  return [year, month, day, weekday === 0 ? 7 : weekday];
}

/** The instant of tenant-local `year-month-day hour:minute`. */
export function localInstant(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute = 0
): number {
  const guess = Date.UTC(year, month - 1, day, hour, minute);
  return guess - zoneOffsetMinutes(guess) * MINUTE_MS;
}

/** The tenant-local day `days` after the real today, at `hour:minute`. */
function realDayAt(days: number, hour: number, minute = 0): number {
  const [year, month, day] = localDate(realNow() + days * DAY_MS);
  return localInstant(year, month, day, hour, minute);
}

/** Days from the real today to the next tenant-local `weekday` (1–7), 0 when today is one. */
function daysUntil(weekday: number): number {
  const today = localDate(realNow())[3];
  return (weekday - today + 7) % 7;
}

/** The Monday of the week after next, days from the real today: Felix's vacation starts then. */
export function vacationStartDays(): number {
  return 8 - localDate(realNow())[3] + 7;
}

/** The instant each moment stands for, on the real calendar. */
export function momentInstant(moment: Moment): number {
  switch (moment) {
    case 'now':
      return realNow();
    case 'officeDay':
      return realDayAt(daysUntil(2), 10, 30);
    case 'evening':
      return realDayAt(daysUntil(2), 19, 0);
    case 'holidays': {
      const [year, month, day] = localDate(realNow());
      const closureYear = month === 1 && day <= 2 ? year - 1 : year;
      return localInstant(closureYear, 12, 29, 10, 0);
    }
    case 'vacation':
      return realDayAt(vacationStartDays() + 2, 11, 0);
  }
}

/** Sets the clock to `moment`. The caller restarts the demo so its data fits the moment. */
export function setMoment(moment: Moment): void {
  clock.moment = moment;
  clock.offsetMs = moment === 'now' ? 0 : momentInstant(moment) - realNow();
  save();
}
