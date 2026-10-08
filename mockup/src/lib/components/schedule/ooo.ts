/**
 * Pure geometry of the out-of-office timeline: the visible window, its month ticks, and where each
 * rule's bar sits. All instants are epoch milliseconds; positions are percent of the window.
 *
 * The window opens at the start of today and spans about 90 days, extended to show the furthest
 * bound of any rule and closed at the start of a month so the last tick sits on the edge. A rule
 * without `startsAt` applies from now; a rule without `expiresAt` is open-ended and its bar runs
 * to the window's end.
 */
import type { OooRule } from '#lib/api/types.js';

const DAY_MS = 86_400_000;
export const DEFAULT_SPAN_DAYS = 90;

export type TimelineWindow = { start: number; end: number };
export type MonthTick = { time: number; percent: number };
export type RuleBar = {
  rule: OooRule;
  leftPercent: number;
  widthPercent: number;
  /** The rule began before the window: the bar starts flush at its left edge. */
  clippedStart: boolean;
  /** The rule has no expiry: the bar fades out at the right edge. */
  openEnd: boolean;
};

const MIN_WIDTH_PERCENT = 0.75;

const instant = (iso: string | null): number | undefined => {
  if (iso === null) {
    return undefined;
  }
  const time = Date.parse(iso);
  return Number.isNaN(time) ? undefined : time;
};

const startOfDay = (time: number): number => {
  const date = new Date(time);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
};

const startOfNextMonth = (time: number): number => {
  const date = new Date(time);
  return new Date(date.getFullYear(), date.getMonth() + 1, 1).getTime();
};

/** The rules the timeline shows: not deleted and not yet expired at `now`. */
export const visibleRules = (rules: OooRule[], now: number): OooRule[] =>
  rules
    .filter(rule => {
      const expires = instant(rule.expiresAt);
      return (
        rule.deletedAt === null && (expires === undefined || expires > now)
      );
    })
    .toSorted(
      (first, second) =>
        (instant(first.startsAt) ?? now) - (instant(second.startsAt) ?? now)
    );

export const timelineWindow = (
  rules: OooRule[],
  now: number
): TimelineWindow => {
  const start = startOfDay(now);
  let furthest = start + DEFAULT_SPAN_DAYS * DAY_MS;

  for (const rule of visibleRules(rules, now)) {
    for (const bound of [instant(rule.startsAt), instant(rule.expiresAt)]) {
      if (bound !== undefined) {
        furthest = Math.max(furthest, bound);
      }
    }
  }

  return { start, end: startOfNextMonth(furthest) };
};

export const percentOf = (time: number, window: TimelineWindow): number =>
  ((time - window.start) / (window.end - window.start)) * 100;

/** The first day of every month after the window's start, up to its end. */
export const monthTicks = (window: TimelineWindow): MonthTick[] => {
  const ticks: MonthTick[] = [];
  for (
    let time = startOfNextMonth(window.start);
    time <= window.end;
    time = startOfNextMonth(time)
  ) {
    ticks.push({ time, percent: percentOf(time, window) });
  }
  return ticks;
};

export const ruleBar = (
  rule: OooRule,
  window: TimelineWindow,
  now: number
): RuleBar => {
  const starts = instant(rule.startsAt) ?? now;
  const expires = instant(rule.expiresAt);
  const from = Math.max(starts, window.start);
  const to = Math.min(expires ?? window.end, window.end);
  const leftPercent = percentOf(from, window);

  return {
    rule,
    leftPercent,
    widthPercent: Math.max(
      percentOf(to, window) - leftPercent,
      MIN_WIDTH_PERCENT
    ),
    clippedStart: starts < window.start,
    openEnd: expires === undefined
  };
};
