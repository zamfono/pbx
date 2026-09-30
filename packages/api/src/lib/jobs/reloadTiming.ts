/**
 * The maintenance moment a detected TLS certificate change is applied at (§6.4 "Reload timing"):
 * the tenant's own quiet windows first, a configured quiet hour otherwise.
 */
import process from 'node:process';

import { MS_PER_DAY, type Db } from '@zamfono/shared';

import { loadIntervals, loadSchedule } from '../ops/hours/_shared.js';
import { liveOooRulesInScope } from '../ops/ooo/_shared.js';
import { loadSettings } from '../ops/settings/_shared.js';
import { tenantTimeZone } from '../tenantTimeZone.js';
import {
  addDays,
  DAYS_TO_SCAN,
  localParts,
  longestClosedGap,
  MINUTES_PER_HOUR,
  zonedInstant
} from './scheduleMath.js';

const DEFAULT_RELOAD_HOUR = 3;
const MIDPOINT_DIVISOR = 2;
const MAX_VALID_HOUR = 23;

/**
 * The current or next tenant-wide OOO period's midpoint (§6.4 step 1), when one starts within
 * the coming 7 days and that midpoint still lies in the future; `null` otherwise.
 */
async function tenantOooMidpointMs(
  db: Db,
  fromMs: number
): Promise<number | null> {
  const horizonMs = fromMs + DAYS_TO_SCAN * MS_PER_DAY;
  const rules = await liveOooRulesInScope(db, { kind: 'tenant' });
  for (const rule of rules) {
    if (
      rule.active !== 1 ||
      rule.startsAt === null ||
      rule.expiresAt === null
    ) {
      continue;
    }
    const startsAtMs = Date.parse(rule.startsAt);
    const expiresAtMs = Date.parse(rule.expiresAt);
    const isCurrent = startsAtMs <= fromMs && fromMs < expiresAtMs;
    const startsSoon = startsAtMs > fromMs && startsAtMs <= horizonMs;
    if (!isCurrent && !startsSoon) {
      continue;
    }
    const midpointMs =
      startsAtMs + (expiresAtMs - startsAtMs) / MIDPOINT_DIVISOR;
    if (midpointMs > fromMs) {
      return midpointMs;
    }
  }
  return null;
}

/**
 * §6.4 step 2's outcome: the tenant opening-hours schedule's longest closed period's midpoint,
 * `'closedThroughout'` for a schedule with no open intervals at all (apply at once), or `null`
 * when no active tenant schedule exists, or its whole 7-day window is open.
 */
async function tenantScheduleMomentMs(
  db: Db,
  fromMs: number,
  timezone: string
): Promise<number | 'closedThroughout' | null> {
  const schedule = await loadSchedule(db, { kind: 'tenant' });
  if (schedule?.active !== 1) {
    return null;
  }
  const intervals = await loadIntervals(db, schedule.id);
  if (intervals.length === 0) {
    return 'closedThroughout';
  }
  const gap = longestClosedGap(intervals, fromMs, timezone);
  if (!gap) {
    return null;
  }
  return gap.start + (gap.end - gap.start) / MIDPOINT_DIVISOR;
}

/** The next occurrence, at or after `fromMs`, of the wall-clock hour `hour` in `timezone`. */
function nextHourOccurrenceMs(
  fromMs: number,
  hour: number,
  timezone: string
): number {
  const local = localParts(fromMs, timezone);
  const targetMinuteOfDay = hour * MINUTES_PER_HOUR;
  const todayMs = zonedInstant(
    local.year,
    local.month,
    local.day,
    targetMinuteOfDay,
    timezone
  );
  if (todayMs > fromMs) {
    return todayMs;
  }
  const tomorrow = addDays(local, 1);
  return zonedInstant(
    tomorrow.year,
    tomorrow.month,
    tomorrow.day,
    targetMinuteOfDay,
    timezone
  );
}

/** `TLS_RELOAD_HOUR` as an integer hour `0`-`23`, `null` when unset, empty or out of range. */
function parseReloadHourEnv(value: string | undefined): number | null {
  if (value === undefined || value === '') {
    return null;
  }
  const hour = Number(value);
  if (!Number.isInteger(hour) || hour < 0 || hour > MAX_VALID_HOUR) {
    return null;
  }
  return hour;
}

/**
 * The next maintenance moment a detected certificate change is applied at (§6.4 "Reload
 * timing"), in this priority: the current/next tenant OOO period's midpoint; the longest closed
 * period of the tenant opening hours; `settings.tls_reload_hour`; the `TLS_RELOAD_HOUR`
 * environment variable; the next 03:00. The safety valve of an expiring current certificate is
 * the caller's concern (`certSync.ts`), since it needs the certificate itself, not this schedule.
 */
export async function nextMaintenanceMoment(db: Db, now: Date): Promise<Date> {
  const settings = await loadSettings(db);
  const timezone = tenantTimeZone(settings.timezone);
  const fromMs = now.getTime();

  const oooMs = await tenantOooMidpointMs(db, fromMs);
  if (oooMs !== null) {
    return new Date(oooMs);
  }

  const scheduleMoment = await tenantScheduleMomentMs(db, fromMs, timezone);
  if (scheduleMoment === 'closedThroughout') {
    return now;
  }
  if (scheduleMoment !== null) {
    return new Date(scheduleMoment);
  }

  if (settings.tlsReloadHour !== null) {
    return new Date(
      nextHourOccurrenceMs(fromMs, settings.tlsReloadHour, timezone)
    );
  }
  const envHour = parseReloadHourEnv(process.env.TLS_RELOAD_HOUR);
  if (envHour !== null) {
    return new Date(nextHourOccurrenceMs(fromMs, envHour, timezone));
  }
  return new Date(nextHourOccurrenceMs(fromMs, DEFAULT_RELOAD_HOUR, timezone));
}
