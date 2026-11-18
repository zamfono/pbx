import { z } from 'zod';

import {
  childConditions,
  conditionColumns,
  dateRangeProblem,
  DECISION_STATUSES,
  HTTP_UNPROCESSABLE_CONTENT,
  isE164,
  MAX_CONDITION_DEPTH,
  newId,
  type Db,
  type DecisionCondition
} from '@zamfono/shared';

import { intervalSchema, validateIntervals } from '../hours/_shared.js';
import { liveRow } from '../rows.js';
import { OpError } from '../types.js';

const userIdField = z.string().describe('A live user (users.list).');

/**
 * One condition of a case (§10.1 step 7 "Decisions"), discriminated on `type`; an operator nests
 * further conditions. Every condition is instant and reads only the time, the caller and the
 * users it names.
 */
export const conditionSchema: z.ZodType<DecisionCondition> = z
  .discriminatedUnion('type', [
    z.strictObject({
      type: z
        .literal('schedule')
        .describe(
          'Matches during any of the weekly intervals, in the tenant time zone.'
        ),
      intervals: z
        .array(intervalSchema)
        .min(1)
        .describe(
          'Weekly intervals in the opening-hours shape; none crosses midnight.'
        )
    }),
    z.strictObject({
      type: z
        .literal('dates')
        .describe(
          "Matches on any day of the date ranges, in the tenant's time zone."
        ),
      ranges: z
        .array(
          z
            .strictObject({
              from: z.string(),
              to: z.string()
            })
            .superRefine((range, ctx) => {
              const problem = dateRangeProblem(range);
              if (problem !== null) {
                ctx.addIssue({ code: 'custom', message: problem });
              }
            })
            .describe(
              'Both ends inclusive: YYYY-MM-DD for one-off dates, MM-DD for every year (12-24..01-06 wraps the year end, 02-29 matches in leap years only).'
            )
        )
        .min(1)
    }),
    z.strictObject({
      type: z
        .literal('caller')
        .describe(
          'Matches a caller who is none of the tenant users, by their number.'
        ),
      number: z
        .string()
        .refine(isE164, 'number must be E.164')
        .nullable()
        .describe(
          'The caller number, E.164 such as +436991234567; null matches a withheld caller.'
        ),
      isPrefix: z
        .boolean()
        .default(false)
        .describe('Matches every number beginning with `number`.')
    }),
    z.strictObject({
      type: z
        .literal('callerUser')
        .describe(
          'Matches a tenant user on the caller side: their phone placed the call.'
        ),
      userId: userIdField
        .nullable()
        .default(null)
        .describe('That user alone; null for any of them.')
    }),
    z.strictObject({
      type: z
        .literal('presence')
        .describe("Matches while the user's status is one of `status`."),
      userId: userIdField,
      status: z
        .array(z.enum(DECISION_STATUSES))
        .min(1)
        .describe(
          "away: the user's own out-of-office rule is in effect; closed: outside the user's own opening hours; else busy, dnd, offline or available as presence publishes it."
        )
    }),
    z.strictObject({
      type: z.literal('any').describe('Matches when one of `conditions` does.'),
      get conditions(): z.ZodArray<z.ZodType<DecisionCondition>> {
        return z.array(conditionSchema).min(1);
      }
    }),
    z.strictObject({
      type: z.literal('all').describe('Matches when all `conditions` do.'),
      get conditions(): z.ZodArray<z.ZodType<DecisionCondition>> {
        return z.array(conditionSchema).min(1);
      }
    }),
    z.strictObject({
      type: z.literal('not').describe('Matches when `condition` does not.'),
      get condition(): z.ZodType<DecisionCondition> {
        return conditionSchema;
      }
    })
  ])
  .refine(
    condition =>
      condition.type !== 'caller' ||
      condition.number !== null ||
      !condition.isPrefix,
    { message: 'isPrefix needs a number', path: ['isPrefix'] }
  )
  .meta({ id: 'DecisionCondition' });

/** The users `conditions` name, at any depth. */
function namedUsers(conditions: DecisionCondition[]): string[] {
  return conditions.flatMap(condition => [
    ...('userId' in condition && condition.userId !== null
      ? [condition.userId]
      : []),
    ...namedUsers(childConditions(condition))
  ]);
}

/** Throws 422 for operators nested deeper than `MAX_CONDITION_DEPTH`, or a schedule's invalid
 * interval, and 404 for a user that is not live. */
export async function assertConditionsValid(
  db: Db,
  whens: DecisionCondition[][]
): Promise<void> {
  const check = (conditions: DecisionCondition[], depth: number): void => {
    for (const condition of conditions) {
      if (depth > MAX_CONDITION_DEPTH) {
        throw new OpError(
          HTTP_UNPROCESSABLE_CONTENT,
          `decisions: conditions nest deeper than ${MAX_CONDITION_DEPTH}`
        );
      }
      if (condition.type === 'schedule') {
        validateIntervals(condition.intervals);
      }
      check(childConditions(condition), depth + 1);
    }
  };
  for (const when of whens) {
    check(when, 1);
  }
  const userIds = [...new Set(whens.flatMap(namedUsers))];
  for (const userId of userIds) {
    // eslint-disable-next-line no-await-in-loop -- the first unknown user is the one refused
    await liveRow(db, 'users', userId, `user '${userId}' not found`);
  }
}

/** Inserts `conditions`' rows under `parentId` (`null` at the top of a case), in order. */
export async function insertConditions(
  db: Db,
  owner: { decisionId: string; caseId: string },
  conditions: DecisionCondition[],
  parentId: string | null
): Promise<void> {
  for (const [position, condition] of conditions.entries()) {
    const id = newId();
    // eslint-disable-next-line no-await-in-loop -- a child row names its parent, inserted first
    await db
      .insertInto('decisionConditions')
      .values({
        id,
        ...owner,
        parentId,
        position,
        ...conditionColumns(condition)
      })
      .execute();
    // eslint-disable-next-line no-await-in-loop -- as above
    await insertConditions(db, owner, childConditions(condition), id);
  }
}
