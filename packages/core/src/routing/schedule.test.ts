import { describe, expect, it } from 'vitest';

import {
  inEffectOoo,
  isOpen,
  nextTransition,
  scheduleFor,
  type OooRule,
  type Schedule
} from './schedule.js';

const rule = (overrides: Partial<OooRule>): OooRule => ({
  id: 'rule-1',
  scope: 'tenant',
  active: true,
  startsAt: null,
  expiresAt: null,
  targetId: 'target-1',
  ...overrides
});

describe('inEffectOoo', () => {
  it('does not apply a rule whose startsAt lies in the future', () => {
    const rules = [rule({ startsAt: '2030-01-01T00:00:00.000Z' })];

    expect(inEffectOoo(rules, 'tenant', '2026-01-01T00:00:00.000Z')).toBeNull();
  });

  it('does not apply an expired rule', () => {
    const rules = [rule({ expiresAt: '2020-01-01T00:00:00.000Z' })];

    expect(inEffectOoo(rules, 'tenant', '2026-01-01T00:00:00.000Z')).toBeNull();
  });

  it("prefers the scope's own in-effect rule over the tenant's", () => {
    const rules = [
      rule({ id: 'tenant-rule', scope: 'tenant' }),
      rule({ id: 'user-rule', scope: 'user:u1' })
    ];

    const result = inEffectOoo(rules, 'user:u1', '2026-01-01T00:00:00.000Z');

    expect(result?.id).toBe('user-rule');
  });

  it('falls back to the tenant rule when the scope has none in effect', () => {
    const rules = [rule({ id: 'tenant-rule', scope: 'tenant' })];

    const result = inEffectOoo(rules, 'user:u1', '2026-01-01T00:00:00.000Z');

    expect(result?.id).toBe('tenant-rule');
  });
});

const weekdayHoursSchedule = (overrides: Partial<Schedule> = {}): Schedule => ({
  id: 'schedule-1',
  scope: 'tenant',
  active: true,
  closedTargetId: 'target-1',
  intervals: [1, 2, 3, 4, 5].map(weekday => ({
    weekday: weekday as 1 | 2 | 3 | 4 | 5,
    opens: '09:00',
    closes: '17:00'
  })),
  ...overrides
});

describe('isOpen', () => {
  const schedule = weekdayHoursSchedule();

  it('is open at 09:30 local on a Monday within 09:00-17:00', () => {
    // 2026-03-30T07:30Z is 09:30 CEST (Europe/Berlin already in summer time).
    expect(isOpen(schedule, '2026-03-30T07:30:00.000Z', 'Europe/Berlin')).toBe(
      true
    );
  });

  it('is closed at 17:30 local, past the 17:00 close', () => {
    // 2026-03-30T15:30Z is 17:30 CEST.
    expect(isOpen(schedule, '2026-03-30T15:30:00.000Z', 'Europe/Berlin')).toBe(
      false
    );
  });

  it("treats an interval closing at '24:00' as open through 23:59", () => {
    const midnightSchedule = weekdayHoursSchedule({
      intervals: [{ weekday: 1, opens: '00:00', closes: '24:00' }]
    });

    // 2026-03-30T21:59Z is 23:59 CEST on the same Monday.
    expect(
      isOpen(midnightSchedule, '2026-03-30T21:59:00.000Z', 'Europe/Berlin')
    ).toBe(true);
  });
});

describe('scheduleFor', () => {
  it("falls back to the tenant's active schedule when the scope's own schedule is inactive", () => {
    const schedules = [
      weekdayHoursSchedule({
        id: 'user-schedule',
        scope: 'user:u1',
        active: false
      }),
      weekdayHoursSchedule({
        id: 'tenant-schedule',
        scope: 'tenant',
        active: true
      })
    ];

    expect(scheduleFor(schedules, 'user:u1')?.id).toBe('tenant-schedule');
  });
});

describe('nextTransition', () => {
  it("is the nearest future bound of an active rule, ignoring an inactive one's", () => {
    const rules = [
      rule({ startsAt: '2026-01-01T12:00:00.000Z' }),
      rule({ active: false, startsAt: '2026-01-01T10:30:00.000Z' }),
      rule({
        startsAt: '2026-01-01T09:00:00.000Z',
        expiresAt: '2026-01-01T11:00:00.000Z'
      })
    ];

    expect(nextTransition(rules, [], '2026-01-01T10:00:00.000Z', 'UTC')).toBe(
      Date.parse('2026-01-01T11:00:00.000Z')
    );
  });

  it("is a schedule's next open or close edge in its zone", () => {
    // Wednesday 2026-03-18 18:00 CET: closed, next opening Thursday 09:00 CET (08:00Z).
    expect(
      nextTransition(
        [],
        [weekdayHoursSchedule()],
        '2026-03-18T17:00:00.000Z',
        'Europe/Berlin'
      )
    ).toBe(Date.parse('2026-03-19T08:00:00.000Z'));
  });

  it('is null with nothing that can change: no rules, an always-closed schedule', () => {
    expect(
      nextTransition(
        [rule({})],
        [weekdayHoursSchedule({ intervals: [] })],
        '2026-01-01T10:00:00.000Z',
        'UTC'
      )
    ).toBeNull();
  });
});
