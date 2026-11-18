/**
 * A decision's dry run between `api` and `core` (§10.3 "Decisions"): the internal API's request
 * and answer.
 */
import { z } from 'zod';

import { DECISION_STATUSES, type ConditionResult } from './decisions.js';

/** `POST /internal/decisions/{id}/dryRun` → 200 `DecisionDryRunResponse`, 404 for a decision that
 * is not live (§10.3 "Decisions"): the decision evaluated at `at` for `caller`, a number (`null`
 * withheld) or a user, `presence` standing in for the users' effective status and `values` for
 * the call's template values (§9.4 "Templates"), then the resolved target's OOO and, for an
 * `inbound` call, opening hours. */
export const decisionDryRunRequestSchema = z.object({
  at: z.string(),
  caller: z.union([
    z.object({ number: z.string().nullable() }),
    z.object({ userId: z.string() })
  ]),
  direction: z.enum(['inbound', 'internal']),
  presence: z.record(z.string(), z.enum(DECISION_STATUSES)),
  values: z.record(z.string(), z.unknown())
});
export type DecisionDryRunRequest = z.infer<typeof decisionDryRunRequestSchema>;

/** An OOO or opening-hours scope as the dry run names it. */
export type DryRunScope =
  | { kind: 'user' | 'ringGroup' | 'menu'; id: string }
  | {
      kind: 'tenant';
    };

/** The dry run's answer: each decision evaluated, in order, with the case taken (`null` for the
 * default), the forward target it chose and every case's results; the decision met again, if
 * any; the field of the target they end at whose template rendered `value`, no value of that
 * field, if any; and for a user, ring group or menu it resolves to, the OOO rule in effect, else the
 * opening hours that apply (`null` where none does, or for an internal call). Targets are
 * `forward_targets` ids, which `api` reads in its own shape. */
export type DecisionDryRunResponse = {
  evaluations: {
    decisionId: string;
    decisionCase: number | null;
    targetId: string;
    cases: ConditionResult[][];
  }[];
  loop: string | null;
  invalid: { field: string; value: string } | null;
  ooo: { scope: DryRunScope; oooRuleId: string; targetId: string } | null;
  hours: {
    scope: DryRunScope;
    openingHoursId: string;
    open: boolean;
    closedTargetId: string;
  } | null;
};
