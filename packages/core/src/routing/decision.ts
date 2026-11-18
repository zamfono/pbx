/**
 * Decisions (§10.1 step 7 "Decisions"): a decision's conditions evaluated against the time, the
 * caller and the status of the users they name, the case they pick, and the resolution of a
 * target through decisions (and, for the contexts that only resolve, the tenant's own DIDs) to
 * the target the call goes to. Pure functions only: what the evaluation reads is handed in.
 */
import {
  ANONYMOUS,
  conditionsByCase,
  dateInRange,
  renderTemplate,
  type ConditionResult,
  type DecisionCondition,
  type DecisionStatus
} from '@zamfono/shared';

import type { Snapshot } from '../internal/snapshot.js';
import { renderTarget, type Rendered } from './renderTarget.js';
import { isOpen } from './schedule.js';
import { findForwardTarget, type ForwardTarget } from './targets.js';

/** A target that is no decision and no `extension`, its templates rendered: what resolution ends
 * at. */
export type ResolvedTarget = Exclude<
  ForwardTarget,
  { kind: 'decision' | 'extension' }
>;

/**
 * What a decision's conditions read: the time of the evaluation in the tenant's zone, the party
 * on the caller channel, one of the tenant's users or else a number (`ANONYMOUS` for a withheld
 * one), a user's effective status (`away`, `closed`, else the presence core publishes), and the
 * values the call's templates render with (§9.4 "Templates"), which a target's templated fields
 * read too; without them every placeholder renders empty.
 */
export type DecisionInputs = {
  now: string;
  timezone: string;
  caller: { userId: string | null; number: string };
  statusOf: (userId: string) => DecisionStatus;
  values?: Readonly<Record<string, unknown>>;
};

/** The tenant-local date (`YYYY-MM-DD`), ISO weekday and time (`HH:MM`) of `now`. */
function localTime(inputs: DecisionInputs): {
  date: string;
  weekday: number;
  time: string;
} {
  const local = Temporal.Instant.from(inputs.now).toZonedDateTimeISO(
    inputs.timezone
  );
  return {
    date: local.toPlainDate().toString(),
    weekday: local.dayOfWeek,
    time: local.toPlainTime().toString({ smallestUnit: 'minute' })
  };
}

/** The caller as a condition reads it: the user on the caller channel, else their number, `null`
 * for a withheld one. */
function callerValue(inputs: DecisionInputs): {
  userId: string | null;
  number: string | null;
} {
  const { userId, number } = inputs.caller;
  return { userId, number: number === ANONYMOUS ? null : number };
}

/** Whether a caller who is none of the tenant's users has `number` (`null`: withheld), or one
 * starting with it for a prefix: the blocklist's matching (§10.1 Entry). */
function callerMatches(
  condition: Extract<DecisionCondition, { type: 'caller' }>,
  inputs: DecisionInputs
): boolean {
  const { userId, number } = callerValue(inputs);
  if (userId !== null) {
    return false;
  }
  if (condition.number === null || number === null) {
    return condition.number === number;
  }
  return condition.isPrefix
    ? number.startsWith(condition.number)
    : number === condition.number;
}

/** Evaluates `condition` and every condition it nests, each with the input it read. */
export function evaluateCondition(
  condition: DecisionCondition,
  inputs: DecisionInputs
): ConditionResult {
  const { type } = condition;
  switch (condition.type) {
    case 'schedule': {
      const value = localTime(inputs);
      return {
        type,
        matched: isOpen(condition, inputs.now, inputs.timezone),
        value: { weekday: value.weekday, time: value.time }
      };
    }
    case 'dates': {
      const { date } = localTime(inputs);
      return {
        type,
        matched: condition.ranges.some(range => dateInRange(date, range)),
        value: date
      };
    }
    case 'caller':
      return {
        type,
        matched: callerMatches(condition, inputs),
        value: callerValue(inputs)
      };
    case 'callerUser': {
      const { userId } = inputs.caller;
      return {
        type,
        matched:
          userId !== null &&
          (condition.userId === null || condition.userId === userId),
        value: callerValue(inputs)
      };
    }
    case 'presence': {
      const status = inputs.statusOf(condition.userId);
      return {
        type,
        matched: condition.status.includes(status),
        value: status
      };
    }
    case 'template': {
      const value =
        renderTemplate(condition.template, inputs.values ?? {}, 'plain') ?? '';
      return { type, matched: value === condition.equals, value };
    }
    case 'not': {
      const inner = evaluateCondition(condition.condition, inputs);
      return { type, matched: !inner.matched, conditions: [inner] };
    }
    default: {
      const conditions = condition.conditions.map(child =>
        evaluateCondition(child, inputs)
      );
      const matched =
        condition.type === 'any'
          ? conditions.some(result => result.matched)
          : conditions.every(result => result.matched);
      return { type, matched, conditions };
    }
  }
}

/** One evaluation of a decision: the case taken (its index, `null` for the default), where it
 * sends the call, by its `forward_targets` row too, and each case's conditions' results in order. */
export type DecisionEvaluation = {
  decisionId: string;
  caseIndex: number | null;
  targetId: string;
  target: ForwardTarget;
  cases: ConditionResult[][];
};

/** Evaluates decision `decisionId` (a live row, the FK keeps it present): every case's
 * conditions, the first case whose conditions all match taken, else the default. */
export function evaluateDecision(
  snapshot: Snapshot,
  decisionId: string,
  inputs: DecisionInputs
): DecisionEvaluation {
  const decision = snapshot.decisions.find(row => row.id === decisionId);
  if (decision === undefined) {
    throw new Error(`decisions: missing row ${decisionId}`);
  }
  const caseRows = snapshot.decisionCases
    .filter(row => row.decisionId === decisionId)
    .sort((left, right) => left.position - right.position);
  const byCase = conditionsByCase(
    snapshot.decisionConditions.filter(row => row.decisionId === decisionId)
  );
  const cases = caseRows.map(row =>
    (byCase.get(row.id) ?? []).map(condition =>
      evaluateCondition(condition, inputs)
    )
  );
  const caseIndex = cases.findIndex(results =>
    results.every(result => result.matched)
  );
  const taken = caseIndex === -1 ? null : caseIndex;
  const targetId =
    taken === null
      ? decision.defaultTargetId
      : (caseRows[taken]?.targetId ?? decision.defaultTargetId);
  return {
    decisionId,
    caseIndex: taken,
    targetId,
    target: findForwardTarget(snapshot, targetId),
    cases
  };
}

/** A target resolved through its decisions: the target the call goes to and the announcements of
 * the decisions it passed and its own, in order (§10.1 step 7); the decision met again; or the
 * target whose template rendered `value`, which is no value of its `field` (§10.1 step 7
 * "Templates"). */
export type Resolution =
  | { kind: 'resolved'; target: ResolvedTarget; announcements: string[] }
  | { kind: 'loop'; decisionId: string }
  | { kind: 'invalid'; target: ForwardTarget; field: string; value: string };

/** The resolution of `target`, whose template rendered what `rendered` holds. */
function invalid(
  target: ForwardTarget,
  rendered: Extract<Rendered, { ok: false }>
): Resolution {
  return {
    kind: 'invalid',
    target,
    field: rendered.field,
    value: rendered.value
  };
}

/**
 * Resolves `target` through the decisions it leads to (§10.1 step 7 "Decisions"): each is
 * evaluated, `onEvaluate` told, and its chosen target taken as if the rule had named it; an
 * `extension` target is followed to the target its extension leads to, and the target it ends at
 * has its templates rendered. `seen` holds the decisions evaluated since the last clearing event
 * (§10.1 "Loops"); one met again is a loop. Each decision is added to it.
 */
export function resolveDecisions(
  snapshot: Snapshot,
  target: ForwardTarget,
  inputs: DecisionInputs,
  seen: Set<string>,
  onEvaluate: (evaluation: DecisionEvaluation) => void = () => undefined
): Resolution {
  const announcements: string[] = [];
  let current = target;
  // An extension leads to a user, a ring group, a menu or a decision, never to another
  // extension, so the decisions' loop set bounds this loop too.
  while (current.kind === 'decision' || current.kind === 'extension') {
    if (current.announcementAudioId !== undefined) {
      announcements.push(current.announcementAudioId);
    }
    if (current.kind === 'extension') {
      const rendered = renderTarget(snapshot, current, inputs.values ?? {});
      if (!rendered.ok) {
        return invalid(current, rendered);
      }
      current = rendered.target;
    } else {
      if (seen.has(current.decisionId)) {
        return { kind: 'loop', decisionId: current.decisionId };
      }
      seen.add(current.decisionId);
      const evaluation = evaluateDecision(snapshot, current.decisionId, inputs);
      onEvaluate(evaluation);
      current = evaluation.target;
    }
  }
  if (current.announcementAudioId !== undefined) {
    announcements.push(current.announcementAudioId);
  }
  const rendered = renderTarget(snapshot, current, inputs.values ?? {});
  if (!rendered.ok) {
    return invalid(current, rendered);
  }
  return {
    kind: 'resolved',
    target: rendered.target as ResolvedTarget,
    announcements
  };
}
