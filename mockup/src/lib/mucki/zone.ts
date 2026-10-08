/**
 * Calendar arithmetic in the tenant's time zone (Europe/Berlin), for the instants Mucki's scenarios
 * pass to operations: ISO 8601 with the zone's offset at that moment, as a person in Munich means
 * "24 December, midnight".
 */

const TIME_ZONE = 'Europe/Berlin';
const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;

type LocalParts = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  weekday: number;
};

const WEEKDAYS: Record<string, number> = {
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
  Sun: 7
};

/** The tenant-local calendar fields of `date`; `weekday` 1 (Monday) … 7. */
export function localParts(date: Date): LocalParts {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: TIME_ZONE,
    hourCycle: 'h23',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    weekday: 'short'
  }).formatToParts(date);
  const get = (type: string): string =>
    parts.find(part => part.type === type)?.value ?? '0';
  return {
    year: Number(get('year')),
    month: Number(get('month')),
    day: Number(get('day')),
    hour: Number(get('hour')),
    minute: Number(get('minute')),
    weekday: WEEKDAYS[get('weekday')] ?? 1
  };
}

/** Minutes the zone is ahead of UTC at `date`. */
function offsetMinutes(date: Date): number {
  const local = localParts(date);
  const asUtc = Date.UTC(
    local.year,
    local.month - 1,
    local.day,
    local.hour,
    local.minute
  );
  return Math.round(
    (asUtc - Math.floor(date.getTime() / MINUTE_MS) * MINUTE_MS) / MINUTE_MS
  );
}

const pad = (value: number): string => String(value).padStart(2, '0');

/** Tenant-local wall-clock time as ISO 8601 with the zone's offset: `2026-12-24T00:00:00+01:00`. */
export function zonedIso(
  year: number,
  month: number,
  day: number,
  hour = 0,
  minute = 0
): string {
  const guess = new Date(Date.UTC(year, month - 1, day, hour, minute));
  const offset = offsetMinutes(
    new Date(guess.getTime() - offsetMinutes(guess) * MINUTE_MS)
  );
  const sign = offset >= 0 ? '+' : '-';
  const absolute = Math.abs(offset);
  // Date.UTC normalises overflowing days (32 December → 1 January).
  const normal = new Date(Date.UTC(year, month - 1, day, hour, minute));
  return (
    `${normal.getUTCFullYear()}-${pad(normal.getUTCMonth() + 1)}-${pad(normal.getUTCDate())}` +
    `T${pad(normal.getUTCHours())}:${pad(normal.getUTCMinutes())}:00` +
    `${sign}${pad(Math.floor(absolute / 60))}:${pad(absolute % 60)}`
  );
}

/** 24 December 00:00 to 27 December 00:00: this year's, or next year's once this one has passed. */
export function christmasClosure(now: Date): {
  startsAt: string;
  expiresAt: string;
  year: number;
} {
  const today = localParts(now);
  const passed = today.month === 12 && today.day >= 27;
  const year = passed ? today.year + 1 : today.year;
  return {
    startsAt: zonedIso(year, 12, 24),
    expiresAt: zonedIso(year, 12, 27),
    year
  };
}

/** Next week's Monday 00:00 to Saturday 00:00, tenant-local. */
export function nextWeek(now: Date): { startsAt: string; expiresAt: string } {
  const today = localParts(now);
  const toMonday = 8 - today.weekday;
  const monday = new Date(
    Date.UTC(today.year, today.month - 1, today.day) + toMonday * DAY_MS
  );
  const y = monday.getUTCFullYear();
  const m = monday.getUTCMonth() + 1;
  const d = monday.getUTCDate();
  return { startsAt: zonedIso(y, m, d), expiresAt: zonedIso(y, m, d + 5) };
}

/** The tenant-local midnight `daysBack` days before `now`. */
export function dayStart(now: Date, daysBack: number): string {
  const today = localParts(now);
  return zonedIso(today.year, today.month, today.day - daysBack);
}

/** Whether `iso` falls on tenant-local `hour:minute`, give or take `toleranceMin` minutes. */
export function isAround(
  iso: string,
  hour: number,
  minute: number,
  toleranceMin = 5
): boolean {
  const local = localParts(new Date(iso));
  return (
    Math.abs(local.hour * 60 + local.minute - (hour * 60 + minute)) <=
    toleranceMin
  );
}
