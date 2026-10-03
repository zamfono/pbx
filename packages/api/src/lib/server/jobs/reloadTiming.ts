/**
 * The maintenance moment a detected TLS certificate change is applied at (§6.4 "Reload timing"):
 * the tenant's own quiet windows first, a configured quiet hour otherwise.
 */

import * as env from '$app/env/private';

import { MS_PER_DAY, wallClockMs, type Db } from '@zamfono/shared';

import { loadIntervals, loadSchedule } from '../ops/hours/_shared.js';
import { liveOooRulesInScope } from '../ops/ooo/_shared.js';
import { loadSettings } from '../ops/settings/_shared.js';
import { tenantTimeZone } from '../tenantTimeZone.js';
import { DAYS_TO_SCAN, longestClosedGap } from './scheduleMath.js';

const DEFAULT_RELOAD_HOUR = 3;
const MIDPOINT_DIVISOR = 2;

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
  const today = Temporal.Instant.fromEpochMilliseconds(fromMs)
    .toZonedDateTimeISO(timezone)
    .toPlainDate();
  const occurrenceMs = (date: Temporal.PlainDate): number =>
    wallClockMs(date.toPlainDateTime({ hour }), timezone);
  const todayMs = occurrenceMs(today);
  return todayMs > fromMs ? todayMs : occurrenceMs(today.add({ days: 1 }));
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
  if (env.TLS_RELOAD_HOUR !== undefined) {
    return new Date(
      nextHourOccurrenceMs(fromMs, env.TLS_RELOAD_HOUR, timezone)
    );
  }
  return new Date(nextHourOccurrenceMs(fromMs, DEFAULT_RELOAD_HOUR, timezone));
}
