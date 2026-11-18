import { z } from 'zod';

import {
  DECISION_CONDITION_TYPES,
  DECISION_STATUSES,
  HTTP_NOT_FOUND,
  HTTP_SERVICE_UNAVAILABLE,
  isE164,
  type ConditionResult
} from '@zamfono/shared';

import { getCoreClient } from '#lib/server/coreClient.js';
import { readTenantTimeZone } from '#lib/server/tenantTimeZone.js';

import { targetSpecSchema } from '../forwardTargetSchema.js';
import { resolveTarget } from '../forwardTargetSpec.js';
import { instantInput, toStoredInstant } from '../instantInput.js';
import { liveRow } from '../rows.js';
import { defineOperation } from '../types.js';
import { liveDecision } from './_shared.js';

const conditionResult: z.ZodType<ConditionResult> = z
  .object({
    type: z.enum(DECISION_CONDITION_TYPES),
    matched: z.boolean(),
    value: z
      .unknown()
      .optional()
      .describe(
        'The input the condition read: the tenant-local weekday and time, the date, the caller, the status.'
      ),
    get conditions(): z.ZodOptional<z.ZodArray<z.ZodType<ConditionResult>>> {
      return z.array(conditionResult).optional();
    }
  })
  .meta({ id: 'DecisionConditionResult' });

const scopeOut = z.object({
  kind: z.enum(['user', 'ringGroup', 'menu', 'tenant']),
  id: z.string().optional()
});

const dryRunOut = z.object({
  evaluations: z
    .array(
      z.object({
        decisionId: z.string(),
        name: z.string(),
        decisionCase: z
          .number()
          .nullable()
          .describe('The case taken, from 0; null for the default.'),
        target: targetSpecSchema,
        cases: z
          .array(z.array(conditionResult))
          .describe("Each case's conditions, every one evaluated.")
      })
    )
    .describe('Each decision evaluated, nested ones after the first.'),
  loop: z
    .object({ decisionId: z.string(), name: z.string() })
    .nullable()
    .describe(
      'A decision met a second time, which ends a call as at the hop limit.'
    ),
  target: targetSpecSchema
    .nullable()
    .describe(
      'Where the decisions send the call, a template in it as written; null on a loop.'
    ),
  invalid: z
    .object({ field: z.string(), value: z.string() })
    .nullable()
    .describe(
      "The target's templated field and what it rendered to for these values, where that is no usable value: a call would take the target's fallback, else end."
    ),
  ooo: z
    .object({
      scope: scopeOut,
      oooRuleId: z.string(),
      target: targetSpecSchema
    })
    .nullable()
    .describe(
      "The out-of-office rule in effect for that user, ring group or menu, its own else the tenant's, which overrides the decision."
    ),
  hours: z
    .object({
      scope: scopeOut,
      openingHoursId: z.string(),
      open: z.boolean(),
      closedTarget: targetSpecSchema
    })
    .nullable()
    .describe(
      "The opening hours that apply to an inbound call, its own else the tenant's; while closed they override the decision."
    )
});

/** `POST /decisions/{id}/dryRun` (§10.3 "Decisions"): which case a call would take, evaluated in
 * `core` like a call, and what OOO and opening hours then make of it. Changes nothing. */
export const dryRunDecision = defineOperation({
  name: 'decisions.dryRun',
  description:
    "Shows which case a decision takes for a given time, caller and presence, each condition's result and the input it read, and the OOO rule or opening hours that apply downstream; changes nothing.",
  input: z
    .object({
      id: z.string(),
      at: instantInput
        .optional()
        .describe(
          'The time evaluated, ISO 8601; without an offset in the tenant time zone; now when left out.'
        ),
      caller: z
        .union([
          z.strictObject({
            number: z
              .string()
              .refine(isE164, 'number must be E.164')
              .nullable()
              .describe('An outside caller, E.164; null for a withheld number.')
          }),
          z.strictObject({
            userId: z.string().describe('A tenant user calling.')
          })
        ])
        .describe('Who calls.'),
      direction: z
        .enum(['inbound', 'internal'])
        .optional()
        .describe(
          'inbound applies opening hours, internal does not; left out, inbound for a number, internal for a user.'
        ),
      presence: z
        .record(z.string(), z.enum(DECISION_STATUSES))
        .default({})
        .describe(
          "A status per user id standing in for the user's effective status (away, closed, busy, dnd, offline, available)."
        ),
      values: z
        .record(z.string(), z.unknown())
        .default({})
        .describe(
          'The values templates render with, by placeholder or HTTP request name, such as { "did": "+4312345617" }; left out, only the caller number, direction, language and time are known (see zamfono.help templates).'
        )
    })
    .strict(),
  output: dryRunOut,
  // Evaluated in `core`, which may fail or not answer (`coreHttp.ts`).
  problems: [HTTP_NOT_FOUND, HTTP_SERVICE_UNAVAILABLE],
  minRole: 'admin',
  readOnly: true,
  run: async (ctx, input) => {
    await liveDecision(ctx.db, input.id);
    if ('userId' in input.caller) {
      await liveRow(
        ctx.db,
        'users',
        input.caller.userId,
        `user '${input.caller.userId}' not found`
      );
    }
    const at =
      input.at === undefined
        ? ctx.now
        : toStoredInstant(input.at, await readTenantTimeZone(ctx.db));
    const result = await getCoreClient().decisionDryRun(input.id, {
      at,
      caller: input.caller,
      direction:
        input.direction ?? ('userId' in input.caller ? 'internal' : 'inbound'),
      presence: input.presence,
      values: input.values
    });
    const names = new Map(
      (
        await ctx.db.selectFrom('decisions').select(['id', 'name']).execute()
      ).map(row => [row.id, row.name])
    );
    const evaluations = await Promise.all(
      result.evaluations.map(async evaluation => ({
        decisionId: evaluation.decisionId,
        name: names.get(evaluation.decisionId) ?? '',
        decisionCase: evaluation.decisionCase,
        target: await resolveTarget(ctx.db, evaluation.targetId),
        cases: evaluation.cases
      }))
    );
    return {
      evaluations,
      loop:
        result.loop === null
          ? null
          : { decisionId: result.loop, name: names.get(result.loop) ?? '' },
      target:
        result.loop === null ? (evaluations.at(-1)?.target ?? null) : null,
      invalid: result.invalid,
      ooo:
        result.ooo === null
          ? null
          : {
              scope: result.ooo.scope,
              oooRuleId: result.ooo.oooRuleId,
              target: await resolveTarget(ctx.db, result.ooo.targetId)
            },
      hours:
        result.hours === null
          ? null
          : {
              scope: result.hours.scope,
              openingHoursId: result.hours.openingHoursId,
              open: result.hours.open,
              closedTarget: await resolveTarget(
                ctx.db,
                result.hours.closedTargetId
              )
            }
    };
  }
});
