import { afterEach, describe, expect, it } from 'vitest';

import { OOO } from '#lib/api/seed/ids.js';
import { seed } from '#lib/api/seed/index.js';
import { localDate, now, setMoment } from '#lib/clock.svelte.js';
import {
  ruleInEffect,
  scopeStatus,
  TENANT
} from '#lib/components/schedule-scope/status.js';

const berlinTime = (ms: number): string =>
  new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Berlin',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23'
  }).format(new Date(ms));

afterEach(() => {
  setMoment('now');
});

describe('demo moments', () => {
  it('runs the office day on a Tuesday morning, open', () => {
    setMoment('officeDay');
    expect(localDate(now())[3]).toBe(2);
    expect(berlinTime(now())).toBe('10:30');
    expect(scopeStatus(seed(), TENANT, now()).open).toBe(true);
  });

  it('runs the evening on the same Tuesday after closing', () => {
    setMoment('evening');
    expect(localDate(now())[3]).toBe(2);
    expect(berlinTime(now())).toBe('19:00');
    expect(scopeStatus(seed(), TENANT, now()).open).toBe(false);
  });

  it('finds the holiday closure in effect between the years', () => {
    setMoment('holidays');
    const [, month, day] = localDate(now());
    expect([month, day]).toEqual([12, 29]);
    const db = seed();
    expect(scopeStatus(db, TENANT, now()).ooo?.id).toBe(OOO.holidays);
  });

  it("finds Felix's vacation in effect, and only then", () => {
    const rule = (): ReturnType<typeof seed>['oooRules'][number] =>
      seed().oooRules.find(candidate => candidate.id === OOO.felixVacation)!;
    expect(ruleInEffect(rule(), now())).toBe(false);
    setMoment('vacation');
    expect(ruleInEffect(rule(), now())).toBe(true);
  });
});
