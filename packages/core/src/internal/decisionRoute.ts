/**
 * A decision's dry run, `POST /internal/decisions/{id}/dryRun` (§10.3 "Decisions"): evaluated in
 * core, where presence and opening hours live, as a call would evaluate it, nested decisions
 * followed, then the OOO rule and opening hours of the user, ring group or menu it resolves to
 * (§10.1 steps 2-3), and no further. Nothing is dialled or changed. `server.ts` mounts
 * `handleDecisionRoute`.
 */
import type http from 'node:http';

import {
  ANONYMOUS,
  decisionDryRunRequestSchema,
  HTTP_NOT_FOUND,
  HTTP_OK,
  resolveTenantTimeZone,
  type DecisionDryRunRequest,
  type DecisionDryRunResponse,
  type DryRunScope,
  type Scope
} from '@zamfono/shared';

import { effectiveStatus } from '../calls/callDecisions.js';
import { extensionOf } from '../calls/extensionOwner.js';
import {
  resolveDecisions,
  type DecisionEvaluation
} from '../routing/decision.js';
import { inEffectOoo, isOpen, scheduleFor } from '../routing/schedule.js';
import { buildOooRules, buildSchedules } from '../routing/scheduleRows.js';
import {
  readJsonBody,
  respondInvalidBody,
  respondJson,
  respondProblem
} from './http.js';
import type { ConfigCache, Snapshot } from './snapshot.js';
import type { StateStore } from './stateStore.js';

const DRY_RUN_ROUTE = /^\/internal\/decisions\/(?<id>[^/]+)\/dryRun$/u;

type DecisionDeps = { cache: ConfigCache; state: StateStore; stackTz: string };

/** `scope` as the dry run names it. */
function dryRunScope(scope: Scope): DryRunScope {
  if (scope === 'tenant') {
    return { kind: 'tenant' };
  }
  const [kind, id] = scope.split(':');
  return { kind: kind as 'user' | 'ringGroup' | 'menu', id: id ?? '' };
}

/** The OOO rule and opening hours that apply to `scope` at `now`, as §10.1 steps 2-3 take them:
 * an in-effect rule ends there; the hours count for an inbound call alone. */
function downstream(
  snapshot: Snapshot,
  scope: Scope,
  request: DecisionDryRunRequest,
  timezone: string
): Pick<DecisionDryRunResponse, 'ooo' | 'hours'> {
  const ooo = inEffectOoo(buildOooRules(snapshot.oooRules), scope, request.at);
  if (ooo !== null) {
    return {
      ooo: {
        scope: dryRunScope(ooo.scope),
        oooRuleId: ooo.id,
        targetId: ooo.targetId
      },
      hours: null
    };
  }
  const schedule =
    request.direction === 'inbound'
      ? scheduleFor(
          buildSchedules(snapshot.openingHours, snapshot.openingHoursIntervals),
          scope
        )
      : null;
  return {
    ooo: null,
    hours:
      schedule === null
        ? null
        : {
            scope: dryRunScope(schedule.scope),
            openingHoursId: schedule.id,
            open: isOpen(schedule, request.at, timezone),
            closedTargetId: schedule.closedTargetId
          }
  };
}

/** The dry run of decision `decisionId`, `null` for one that is not live. */
export async function dryRun(
  deps: DecisionDeps,
  decisionId: string,
  request: DecisionDryRunRequest
): Promise<DecisionDryRunResponse | null> {
  const snapshot = await deps.cache.get();
  if (!snapshot.decisions.some(row => row.id === decisionId)) {
    return null;
  }
  const timezone = resolveTenantTimeZone(
    snapshot.settings.timezone,
    deps.stackTz
  );
  const clock = { now: request.at, timezone };
  const caller =
    'userId' in request.caller
      ? {
          userId: request.caller.userId,
          // An internal caller's number is their extension, as a call from them has it.
          number:
            extensionOf(snapshot, { userId: request.caller.userId }) ??
            ANONYMOUS
        }
      : { userId: null, number: request.caller.number ?? ANONYMOUS };
  const evaluations: DecisionEvaluation[] = [];
  const resolution = resolveDecisions(
    snapshot,
    { kind: 'decision', decisionId },
    {
      ...clock,
      caller,
      statusOf: effectiveStatus(
        snapshot,
        deps.state.presence,
        clock,
        request.presence
      )
    },
    new Set(),
    evaluation => evaluations.push(evaluation)
  );
  const steps = evaluations.map(evaluation => ({
    decisionId: evaluation.decisionId,
    decisionCase: evaluation.caseIndex,
    targetId: evaluation.targetId,
    cases: evaluation.cases
  }));
  if (resolution.kind === 'loop') {
    return {
      evaluations: steps,
      loop: resolution.decisionId,
      ooo: null,
      hours: null
    };
  }
  const { target } = resolution;
  let scope: Scope | null = null;
  if (target.kind === 'user') {
    scope = `user:${target.userId}`;
  } else if (target.kind === 'ringGroup') {
    scope = `ringGroup:${target.ringGroupId}`;
  } else if (target.kind === 'menu') {
    scope = `menu:${target.menuId}`;
  }
  return {
    evaluations: steps,
    loop: null,
    ...(scope === null
      ? { ooo: null, hours: null }
      : downstream(snapshot, scope, request, timezone))
  };
}

/** Serves the dry-run `POST`; `null` when `pathname` names no decision on its route. */
export function handleDecisionRoute(
  deps: DecisionDeps,
  pathname: string,
  response: http.ServerResponse,
  request: http.IncomingMessage
): Promise<void> | null {
  const segment = DRY_RUN_ROUTE.exec(pathname)?.groups?.id;
  if (segment === undefined) {
    return null;
  }
  return (async () => {
    const parsed = await readJsonBody(request, response);
    if (parsed === null) {
      return;
    }
    const body = decisionDryRunRequestSchema.safeParse(parsed.body);
    if (!body.success) {
      respondInvalidBody(response);
      return;
    }
    const answer = await dryRun(deps, decodeURIComponent(segment), body.data);
    if (answer === null) {
      respondProblem(response, HTTP_NOT_FOUND, 'decision not found');
      return;
    }
    respondJson(response, HTTP_OK, answer);
  })();
}
