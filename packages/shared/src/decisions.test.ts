import { describe, expect, it } from 'vitest';

import {
  childConditions,
  conditionColumns,
  conditionsByCase,
  dateRangeProblem,
  type DecisionCondition,
  type DecisionConditionRow
} from './decisions.js';

describe('date ranges of a dates condition', () => {
  it('takes one-off and yearly ranges, a yearly one across the year end and 02-29', () => {
    expect(dateRangeProblem({ from: '2026-12-24', to: '2027-01-06' })).toBe(
      null
    );
    expect(dateRangeProblem({ from: '12-24', to: '01-06' })).toBe(null);
    expect(dateRangeProblem({ from: '02-29', to: '02-29' })).toBe(null);
  });

  it('refuses mixed forms, impossible dates and a one-off range ending before it starts', () => {
    expect(dateRangeProblem({ from: '2026-12-24', to: '01-06' })).toMatch(
      /mixes/u
    );
    expect(dateRangeProblem({ from: '02-30', to: '03-01' })).toMatch(
      /no range/u
    );
    expect(dateRangeProblem({ from: '2027-02-29', to: '2027-03-01' })).toMatch(
      /no range/u
    );
    expect(dateRangeProblem({ from: '2026-12-24', to: '2026-12-01' })).toMatch(
      /ends before/u
    );
    expect(dateRangeProblem({ from: '24.12.', to: '01-06' })).toMatch(
      /no range/u
    );
  });
});

describe('condition rows', () => {
  it('store a tree one row per condition and read it back in order', () => {
    const when: DecisionCondition[] = [
      {
        type: 'any',
        conditions: [
          { type: 'caller', number: '+43699', isPrefix: true },
          { type: 'caller', number: null, isPrefix: false },
          {
            type: 'not',
            condition: {
              type: 'presence',
              userId: 'u1',
              status: ['away', 'busy']
            }
          }
        ]
      },
      { type: 'callerUser', userId: null },
      { type: 'dates', ranges: [{ from: '12-24', to: '01-06' }] },
      {
        type: 'schedule',
        intervals: [{ weekday: 1, opens: '08:00', closes: '17:00' }]
      }
    ];
    const rows: DecisionConditionRow[] = [];
    const store = (
      conditions: DecisionCondition[],
      parentId: string | null
    ): void => {
      // Stored in reverse, so that reading them back has to order by position.
      [...conditions.entries()].reverse().forEach(([position, condition]) => {
        const id = `${parentId ?? 'top'}.${position}`;
        rows.push({
          id,
          caseId: 'c1',
          parentId,
          position,
          ...conditionColumns(condition)
        });
        store(childConditions(condition), id);
      });
    };
    store(when, null);

    expect(rows.find(row => row.type === 'any')?.valueJson).toBeNull();
    expect(rows.find(row => row.type === 'presence')?.userId).toBe('u1');
    expect(conditionsByCase(rows).get('c1')).toEqual(when);
  });
});
