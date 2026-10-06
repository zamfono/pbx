/**
 * What `*5<target>` dials (§10.2 "Three-way calls": "an extension or an external number, through
 * the normal outbound resolution"): the target string goes through the same `resolveDialed` an
 * ordinary dial does (§10.1 "Outbound" steps 1-6), so the CLIR prefixes, emergency numbers,
 * extensions, E.164 normalization and the tenant's own DIDs all apply. `addParty.ts` dials the
 * result.
 */
import type { Snapshot } from '../internal/snapshot.js';
import { resolveDialed } from '../routing/outbound.js';
import {
  findForwardTarget,
  MAX_HOPS,
  ownDidTarget,
  type ForwardTarget
} from '../routing/targets.js';
import { SIP_NOT_FOUND, SIP_TEMPORARILY_UNAVAILABLE } from '../sipCodes.js';
import { extensionOf } from './extensionOwner.js';
import { recordingOf, type ForwardLeg } from './forwardContext.js';
import { resolveDialedContext } from './outboundLookup.js';

/**
 * The added leg's target and its `calls.to_uri` in the pipeline's vocabulary (§11.2 `calls`):
 * the extension for a colleague or a group, the E.164 form for a number. `clir` is the per-call
 * CLIR prefix, if one was dialled; an external target with a `forward` leg, and a `sip` target,
 * is a DID's own forward, dialled as no user's call and recorded when that target records, like
 * an ordinary dial of that DID (§10.1 step 7); a `sip` target's `to` is the DID's number. `hops`
 * are those an own DID's forward to another own DID's number took to reach a colleague or group.
 */
export type AddedTarget =
  | { kind: 'user'; userId: string; to: string; hops: number }
  | { kind: 'ringGroup'; ringGroupId: string; to: string; hops: number }
  | {
      kind: 'external';
      number: string;
      clir: boolean | null;
      forward?: ForwardLeg;
    }
  | { kind: 'sip'; target: Extract<ForwardTarget, { kind: 'sip' }>; to: string }
  | { kind: 'emergency'; number: string }
  | { kind: 'refuse'; code: number };

/** An own DID's E.164 number (§10.1 Outbound step 4: history sees only that form). */
function didNumber(snapshot: Snapshot, didId: string): string {
  const row = snapshot.dids.find(candidate => candidate.id === didId);
  if (row === undefined) {
    throw new Error(`dids: missing row ${didId}`);
  }
  return row.number;
}

/** `target` followed through every external target that is itself an own DID's number, one hop
 * each, as an ordinary dial of the DID follows it (§10.1 step 7), so it never leaves through a
 * trunk; `null` past the hop limit. */
function followOwnDids(
  snapshot: Snapshot,
  target: ForwardTarget
): { target: ForwardTarget; hops: number } | null {
  let reached = target;
  let hops = 0;
  for (
    let next = ownDidTarget(snapshot, reached);
    next !== null;
    next = ownDidTarget(snapshot, reached)
  ) {
    hops += 1;
    if (hops > MAX_HOPS) {
      return null;
    }
    reached = next;
  }
  return { target: reached, hops };
}

/** An own DID dialled as `*5`'s target (§10.1 Outbound step 5): its user or ring-group target is
 * rung like that extension, an external or SIP one dialled; a mailbox, an announcement or a menu is
 * no party that could join a conversation, so it is refused like an unowned number, and DIDs
 * forwarding to each other past the hop limit with 480, as their mailbox-less last target is. */
function didTarget(
  snapshot: Snapshot,
  targetId: string,
  number: string
): AddedTarget {
  const followed = followOwnDids(
    snapshot,
    findForwardTarget(snapshot, targetId)
  );
  if (followed === null) {
    return { kind: 'refuse', code: SIP_TEMPORARILY_UNAVAILABLE };
  }
  const { target, hops } = followed;
  if (target.kind === 'user') {
    return { kind: 'user', userId: target.userId, to: number, hops };
  }
  if (target.kind === 'ringGroup') {
    return {
      kind: 'ringGroup',
      ringGroupId: target.ringGroupId,
      to: number,
      hops
    };
  }
  if (target.kind === 'external') {
    return {
      kind: 'external',
      number: target.number,
      clir: null,
      // The DID forwards, diverting nobody.
      forward: { diversions: [], headers: [], ...recordingOf(target) }
    };
  }
  if (target.kind === 'sip') {
    return { kind: 'sip', target, to: number };
  }
  return { kind: 'refuse', code: SIP_NOT_FOUND };
}

/** Resolves `*5`'s target string (everything after the feature code) against `snapshot`. */
export function resolveAddedTarget(
  snapshot: Snapshot,
  dialed: string
): AddedTarget {
  const action = resolveDialed(dialed, resolveDialedContext(snapshot));
  switch (action.kind) {
    case 'refuse':
      return { kind: 'refuse', code: action.code };
    case 'emergency':
      return { kind: 'emergency', number: action.number };
    case 'external':
      return {
        kind: 'external',
        number: action.number,
        clir: action.clir
      };
    case 'ownDid':
      return didTarget(
        snapshot,
        action.targetId,
        didNumber(snapshot, action.didId)
      );
    case 'extension': {
      const { owner } = action;
      if (owner.kind === 'parking') {
        // A parked call is retrieved by dialling its slot, not added to another conversation.
        return { kind: 'refuse', code: SIP_NOT_FOUND };
      }
      const ownerRef =
        owner.kind === 'user'
          ? { userId: owner.userId }
          : { ringGroupId: owner.ringGroupId };
      const ext = extensionOf(snapshot, ownerRef);
      if (ext === null) {
        return { kind: 'refuse', code: SIP_NOT_FOUND };
      }
      return owner.kind === 'user'
        ? { kind: 'user', userId: owner.userId, to: ext, hops: 0 }
        : {
            kind: 'ringGroup',
            ringGroupId: owner.ringGroupId,
            to: ext,
            hops: 0
          };
    }
    default:
      // Another feature code is no party to add.
      return { kind: 'refuse', code: SIP_NOT_FOUND };
  }
}
