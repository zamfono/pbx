import type { Snapshot } from '../internal/snapshot.js';
import {
  resolveDecisions,
  type DecisionInputs,
  type ResolvedTarget
} from './decision.js';
import { ownDidTarget, type ForwardTarget } from './targets.js';

/**
 * The pure resolver of the contexts that only resolve and never play (§10.1 step 7 "Decisions": a
 * ring-group member's followed forward, `*5`, a consultation, an added party): `target` through
 * its decisions and the tenant's own DIDs it names, each DID one hop on the `hops` already taken,
 * as `enterOwnDid` counts them, a hop clearing the decisions met before it. `null` for a chain
 * that meets a decision again, passes the hop limit or holds a template that renders no value of
 * its field; such a member is not rung, such a party refused.
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
    if (resolution.kind !== 'resolved') {
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
