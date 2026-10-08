import { describe, expect, test } from 'vitest';

import type { OooRule } from '#lib/api/types.js';

import {
  DEFAULT_SPAN_DAYS,
  monthTicks,
  ruleBar,
  timelineWindow,
  visibleRules
} from './ooo';

const DAY_MS = 86_400_000;
const now = new Date(2026, 9, 8, 11, 30).getTime();
const today = new Date(2026, 9, 8).getTime();
const at = (days: number): string =>
  new Date(today + days * DAY_MS).toISOString();

const rule = (
  id: string,
  startsAt: string | null,
  expiresAt: string | null,
  extra: Partial<OooRule> = {}
): OooRule => ({
  id,
  scope: { kind: 'tenant' },
  active: true,
  startsAt,
  expiresAt,
  target: { kind: 'user', userId: 'u1' },
  createdAt: at(-30),
  deletedAt: null,
  ...extra
});

describe('window', () => {
  test('opens today and spans at least 90 days, closing on a month start', () => {
    const view = timelineWindow([], now);
    expect(view.start).toBe(today);
    expect(view.end).toBeGreaterThanOrEqual(today + DEFAULT_SPAN_DAYS * DAY_MS);
    expect(new Date(view.end).getDate()).toBe(1);
  });

  test('extends to the furthest rule bound', () => {
    const view = timelineWindow([rule('a', at(10), at(200))], now);
    expect(view.end).toBeGreaterThanOrEqual(today + 200 * DAY_MS);
  });

  test('month ticks fall on the first of each month inside the window', () => {
    const ticks = monthTicks(timelineWindow([], now));
    expect(ticks.length).toBeGreaterThanOrEqual(3);
    for (const tick of ticks) {
      expect(new Date(tick.time).getDate()).toBe(1);
      expect(tick.percent).toBeGreaterThan(0);
      expect(tick.percent).toBeLessThanOrEqual(100);
    }
  });
});

describe('rules', () => {
  test('hides deleted and expired rules and sorts by start', () => {
    const visible = visibleRules(
      [
        rule('later', at(20), at(30)),
        rule('expired', at(-10), at(-1)),
        rule('deleted', at(5), at(6), { deletedAt: at(-1) }),
        rule('now', null, at(3))
      ],
      now
    );
    expect(visible.map(({ id }) => id)).toEqual(['now', 'later']);
  });

  test('a rule without start begins now; one without expiry runs to the edge', () => {
    const view = timelineWindow([], now);
    const bar = ruleBar(rule('open', null, null), view, now);
    expect(bar.leftPercent).toBeGreaterThan(0);
    expect(bar.leftPercent + bar.widthPercent).toBeCloseTo(100);
    expect(bar.openEnd).toBe(true);
    expect(bar.clippedStart).toBe(false);
  });

  test('a rule that began before today starts flush at the left edge', () => {
    const view = timelineWindow([], now);
    const bar = ruleBar(rule('running', at(-5), at(5)), view, now);
    expect(bar.leftPercent).toBe(0);
    expect(bar.clippedStart).toBe(true);
    expect(bar.openEnd).toBe(false);
  });
});
