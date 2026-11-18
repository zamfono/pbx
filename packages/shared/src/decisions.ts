/**
 * A decision's conditions (§10.1 step 7 "Decisions", §11.2 `decision_conditions`): the tree the
 * API takes and returns, the rows it is stored as, one per condition with an operator's children
 * naming it as `parent_id`, and the date ranges a `dates` condition holds. `api` writes and reads
 * the rows, `core` evaluates the tree.
 */
import { z } from 'zod';

import { PRESENCE_STATUSES } from './columnValues.js';
import type { OpeningInterval } from './openingHours.js';

/** `decision_conditions.type` (§11.2): the leaf conditions and the three operators. */
export const DECISION_CONDITION_TYPES = [
  'schedule',
  'dates',
  'caller',
  'callerUser',
  'presence',
  'any',
  'all',
  'not'
] as const;
export type DecisionConditionType = (typeof DECISION_CONDITION_TYPES)[number];

/** The statuses a `presence` condition names: the user's own OOO (`away`) and opening hours
 * (`closed`), then the presence core publishes (§10.2 "Presence and BLF"). */
export const DECISION_STATUSES = [
  'away',
  'closed',
  ...PRESENCE_STATUSES
] as const;
export type DecisionStatus = (typeof DECISION_STATUSES)[number];

/** How deep operators nest, a top-level condition being at depth 1: a bound only so that
 * recursive validation and evaluation cannot overflow the stack. */
export const MAX_CONDITION_DEPTH = 32;

/** One date range of a `dates` condition, both ends inclusive: `YYYY-MM-DD` for a one-off range,
 * `MM-DD` for a yearly one, which may wrap the year end. */
export type DateRange = { from: string; to: string };

export type DecisionCondition =
  | { type: 'schedule'; intervals: OpeningInterval[] }
  | { type: 'dates'; ranges: DateRange[] }
  | { type: 'caller'; number: string | null; isPrefix: boolean }
  | { type: 'callerUser'; userId: string | null }
  | { type: 'presence'; userId: string; status: DecisionStatus[] }
  | { type: 'any' | 'all'; conditions: DecisionCondition[] }
  | { type: 'not'; condition: DecisionCondition };

/** One condition's result and the input it read, an operator's with its children's (§10.3
 * "Decisions", the dry run): the time or date of a time condition, the caller of a caller
 * condition, the status of a presence condition. */
export type ConditionResult = {
  type: DecisionConditionType;
  matched: boolean;
  value?: unknown;
  conditions?: ConditionResult[];
};

/** A `decision_conditions` row as the tables hold it (§11.2). */
export type DecisionConditionRow = {
  id: string;
  caseId: string;
  parentId: string | null;
  position: number;
  type: DecisionConditionType;
  valueJson: string | null;
  userId: string | null;
};

const ONE_OFF = /^(?<year>\d{4})-(?<month>\d{2})-(?<day>\d{2})$/u;
const YEARLY = /^(?<month>\d{2})-(?<day>\d{2})$/u;
// A leap year, so that `02-29` is a valid yearly date.
const LEAP_YEAR = 2000;
const YEARLY_LENGTH = 'MM-DD'.length;
const YEAR_PREFIX = 'YYYY-'.length;

/** Whether `month`/`day` of `year` is a day of the calendar. */
function isCalendarDay(year: number, month: number, day: number): boolean {
  try {
    Temporal.PlainDate.from({ year, month, day }, { overflow: 'reject' });
    return true;
  } catch {
    return false;
  }
}

/** The form of one end of a date range: `oneOff` or `yearly`, `null` for an impossible date or
 * any other text. */
function dateForm(value: string): 'oneOff' | 'yearly' | null {
  const oneOff = ONE_OFF.exec(value)?.groups;
  if (oneOff !== undefined) {
    return isCalendarDay(
      Number(oneOff.year),
      Number(oneOff.month),
      Number(oneOff.day)
    )
      ? 'oneOff'
      : null;
  }
  const yearly = YEARLY.exec(value)?.groups;
  if (yearly !== undefined) {
    return isCalendarDay(LEAP_YEAR, Number(yearly.month), Number(yearly.day))
      ? 'yearly'
      : null;
  }
  return null;
}

/** Why `range` is no valid date range, `null` for a valid one: both ends real dates of one form,
 * and a one-off range's start no later than its end. */
export function dateRangeProblem(range: DateRange): string | null {
  const from = dateForm(range.from);
  const to = dateForm(range.to);
  if (from === null || to === null) {
    return `dates: ${range.from}..${range.to} is no range of YYYY-MM-DD or MM-DD dates`;
  }
  if (from !== to) {
    return `dates: ${range.from}..${range.to} mixes a one-off and a yearly date`;
  }
  if (from === 'oneOff' && range.from > range.to) {
    return `dates: ${range.from}..${range.to} ends before it starts`;
  }
  return null;
}

/** Whether `localDate` (`YYYY-MM-DD`, the tenant's date) lies in `range`: a one-off range by
 * date, a yearly one by month and day, across the year end when it wraps. */
export function dateInRange(localDate: string, range: DateRange): boolean {
  if (range.from.length > YEARLY_LENGTH) {
    return range.from <= localDate && localDate <= range.to;
  }
  const monthDay = localDate.slice(YEAR_PREFIX);
  return range.from <= range.to
    ? range.from <= monthDay && monthDay <= range.to
    : monthDay >= range.from || monthDay <= range.to;
}
const intervalsValue = z.object({
  intervals: z.array(
    z.object({ weekday: z.number(), opens: z.string(), closes: z.string() })
  )
});
const rangesValue = z.object({
  ranges: z.array(z.object({ from: z.string(), to: z.string() }))
});
const callerValue = z.object({
  number: z.string().nullable(),
  isPrefix: z.boolean()
});
const statusValue = z.object({ status: z.array(z.enum(DECISION_STATUSES)) });

/** A leaf's `value_json`, decoded with `schema`. */
function decodeValue<T>(row: DecisionConditionRow, schema: z.ZodType<T>): T {
  return schema.parse(JSON.parse(row.valueJson ?? 'null'));
}

/** The row columns a condition sets beside its place in the tree: its type, `value_json` (none
 * for an operator or `callerUser`) and `user_id`. */
export function conditionColumns(
  condition: DecisionCondition
): Pick<DecisionConditionRow, 'type' | 'valueJson' | 'userId'> {
  const { type } = condition;
  switch (condition.type) {
    case 'schedule':
      return {
        type,
        valueJson: JSON.stringify({ intervals: condition.intervals }),
        userId: null
      };
    case 'dates':
      return {
        type,
        valueJson: JSON.stringify({ ranges: condition.ranges }),
        userId: null
      };
    case 'caller':
      return {
        type,
        valueJson: JSON.stringify({
          number: condition.number,
          isPrefix: condition.isPrefix
        }),
        userId: null
      };
    case 'callerUser':
      return { type, valueJson: null, userId: condition.userId };
    case 'presence':
      return {
        type,
        valueJson: JSON.stringify({ status: condition.status }),
        userId: condition.userId
      };
    default:
      return { type, valueJson: null, userId: null };
  }
}

/** The condition `row` holds, its children (for an operator) from `childrenOf`. */
function conditionFromRow(
  row: DecisionConditionRow,
  childrenOf: (parentId: string) => DecisionCondition[]
): DecisionCondition {
  switch (row.type) {
    case 'schedule':
      return { type: 'schedule', ...decodeValue(row, intervalsValue) };
    case 'dates':
      return { type: 'dates', ...decodeValue(row, rangesValue) };
    case 'caller':
      return { type: 'caller', ...decodeValue(row, callerValue) };
    case 'callerUser':
      return { type: 'callerUser', userId: row.userId };
    case 'presence':
      if (row.userId === null) {
        throw new Error(
          `decision_conditions: presence row ${row.id} names no user`
        );
      }
      return {
        type: 'presence',
        userId: row.userId,
        ...decodeValue(row, statusValue)
      };
    case 'not': {
      const [condition] = childrenOf(row.id);
      if (condition === undefined) {
        throw new Error(`decision_conditions: not row ${row.id} has no child`);
      }
      return { type: 'not', condition };
    }
    default:
      return { type: row.type, conditions: childrenOf(row.id) };
  }
}

/** Each case's `when`, by case id, built from the rows of one or more decisions. */
export function conditionsByCase(
  rows: readonly DecisionConditionRow[]
): Map<string, DecisionCondition[]> {
  const children = new Map<string, DecisionConditionRow[]>();
  const tops = new Map<string, DecisionConditionRow[]>();
  for (const row of rows) {
    const [map, key] =
      row.parentId === null ? [tops, row.caseId] : [children, row.parentId];
    map.set(key, [...(map.get(key) ?? []), row]);
  }
  const ordered = (list: DecisionConditionRow[] = []): DecisionConditionRow[] =>
    [...list].sort((left, right) => left.position - right.position);
  const childrenOf = (parentId: string): DecisionCondition[] =>
    ordered(children.get(parentId)).map(row =>
      conditionFromRow(row, childrenOf)
    );
  return new Map(
    [...tops].map(([caseId, list]) => [
      caseId,
      ordered(list).map(row => conditionFromRow(row, childrenOf))
    ])
  );
}

/** `condition`'s direct children: an operator's, none for a leaf. */
export function childConditions(
  condition: DecisionCondition
): DecisionCondition[] {
  if (condition.type === 'any' || condition.type === 'all') {
    return condition.conditions;
  }
  return condition.type === 'not' ? [condition.condition] : [];
}
