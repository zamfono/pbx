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
  type ConditionResult,
  type DecisionCondition,
  type DecisionStatus
} from '@zamfono/shared';

import type { Snapshot } from '../internal/snapshot.js';
import { isOpen } from './schedule.js';
import {
  findForwardTarget,
  ownDidTarget,
  type ForwardTarget
} from './targets.js';

/** A target that is no decision: what resolution ends at. */
export type ResolvedTarget = Exclude<ForwardTarget, { kind: 'decision' }>;

/**
 * What a decision's conditions read: the time of the evaluation in the tenant's zone, the party
 * on the caller channel, one of the tenant's users or else a number (`ANONYMOUS` for a withheld
 * one), and a user's effective status (`away`, `closed`, else the presence core publishes).
 */
export type DecisionInputs = {
  now: string;
  timezone: string;
  caller: { userId: string | null; number: string };
  statusOf: (userId: string) => DecisionStatus;
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
 * the decisions it passed and its own, in order (§10.1 step 7); or the decision met again. */
export type Resolution =
  | { kind: 'resolved'; target: ResolvedTarget; announcements: string[] }
  | { kind: 'loop'; decisionId: string };

/**
 * Resolves `target` through the decisions it leads to (§10.1 step 7 "Decisions"): each is
 * evaluated, `onEvaluate` told, and its chosen target taken as if the rule had named it. `seen`
 * holds the decisions evaluated since the last clearing event (§10.1 "Loops"); one met again is a
 * loop. Each decision is added to it.
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
  while (current.kind === 'decision') {
    if (seen.has(current.decisionId)) {
      return { kind: 'loop', decisionId: current.decisionId };
    }
    seen.add(current.decisionId);
    if (current.announcementAudioId !== undefined) {
      announcements.push(current.announcementAudioId);
    }
    const evaluation = evaluateDecision(snapshot, current.decisionId, inputs);
    onEvaluate(evaluation);
    current = evaluation.target;
  }
  if (current.announcementAudioId !== undefined) {
    announcements.push(current.announcementAudioId);
  }
  return { kind: 'resolved', target: current, announcements };
}

/**
 * The pure resolver of the contexts that only resolve and never play (§10.1 step 7 "Decisions": a
 * ring-group member's followed forward, `*5`, a consultation, an added party): `target` through
 * its decisions and the tenant's own DIDs it names, each DID one hop on the `hops` already taken,
 * as `enterOwnDid` counts them, a hop clearing the decisions met before it. `null` for a chain
 * that meets a decision again or passes the hop limit; such a member is not rung, such a party
 * refused.
 */
export function resolvePure(
  snapshot: Snapshot,
  target: ForwardTarget,
  hops: number,
  inputs: DecisionInputs
): { target: ResolvedTarget; hops: number } | null {
  const seen = new Set<string>();
  let current = target;
  let taken = hops;
  for (;;) {
    const resolution = resolveDecisions(snapshot, current, inputs, seen);
    if (resolution.kind === 'loop') {
      return null;
    }
    const next = ownDidTarget(snapshot, resolution.target);
    if (next === null) {
      return { target: resolution.target, hops: taken };
    }
    taken += 1;
    if (taken > snapshot.settings.maxForwardHops) {
      return null;
    }
    seen.clear();
    current = next;
  }
}
