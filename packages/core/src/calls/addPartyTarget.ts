/**
 * What `*5<target>` dials (§10.2 "Three-way calls": "an extension or an external number, through
 * the normal outbound resolution"): the target string goes through the same `resolveDialed` an
 * ordinary dial does (§10.1 "Outbound" steps 1-6), so the CLIR prefixes, emergency numbers,
 * extensions, E.164 normalization and the tenant's own DIDs all apply. `addParty.ts` dials the
 * result.
 */
import type { Snapshot } from '../internal/snapshot.js';
import { resolvePure, type DecisionInputs } from '../routing/decision.js';
import { resolveDialed } from '../routing/outbound.js';
import { findForwardTarget, type ForwardTarget } from '../routing/targets.js';
import { SIP_NOT_FOUND, SIP_TEMPORARILY_UNAVAILABLE } from '../sipCodes.js';
import { extensionOf } from './extensionOwner.js';
import { recordingOf, ringTimeoutOf, type ForwardLeg } from './forwardLeg.js';
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

/**
 * A forward target dialled as `*5`'s party, resolved without playing anything (§10.1 step 7
 * "Decisions": the pure resolver), through its decisions and the own DIDs it names: an own DID or
 * a decision extension (§10.1 Outbound steps 3 and 5). A user or ring-group outcome is rung like
 * that extension, an external or SIP one dialled; a mailbox, a menu, a WebSocket target or
 * `hangup` is no party that could join a conversation, so it is refused like an unowned number,
 * and a chain past the hop limit or meeting a decision again with 480, as past the hop limit.
 * `to` is the number or extension dialled.
 */
function forwardedTarget(
  snapshot: Snapshot,
  forwarded: ForwardTarget,
  to: string,
  inputs: DecisionInputs
): AddedTarget {
  const followed = resolvePure(snapshot, forwarded, 0, inputs);
  if (followed === null) {
    return { kind: 'refuse', code: SIP_TEMPORARILY_UNAVAILABLE };
  }
  const { target, hops } = followed;
  if (target.kind === 'user') {
    return { kind: 'user', userId: target.userId, to, hops };
  }
  if (target.kind === 'ringGroup') {
    return {
      kind: 'ringGroup',
      ringGroupId: target.ringGroupId,
      to,
      hops
    };
  }
  if (target.kind === 'external') {
    return {
      kind: 'external',
      number: target.number,
      clir: null,
      // A party added with `*5` carries no forwarding context (§9.4 "Forwarded calls").
      forward: {
        diversions: [],
        headers: [],
        ...recordingOf(target),
        ...ringTimeoutOf(target)
      }
    };
  }
  if (target.kind === 'sip') {
    return { kind: 'sip', target, to };
  }
  return { kind: 'refuse', code: SIP_NOT_FOUND };
}

/** Resolves `*5`'s target string (everything after the feature code) against `snapshot`, a
 * decision on the way read with `inputs`: the party who dials it as the caller. */
export function resolveAddedTarget(
  snapshot: Snapshot,
  dialed: string,
  inputs: DecisionInputs
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
      return forwardedTarget(
        snapshot,
        findForwardTarget(snapshot, action.targetId),
        didNumber(snapshot, action.didId),
        inputs
      );
    case 'extension': {
      const { owner } = action;
      if (owner.kind === 'decision') {
        const ext = snapshot.extensions.find(
          row => row.decisionId === owner.decisionId
        )?.ext;
        return forwardedTarget(
          snapshot,
          { kind: 'decision', decisionId: owner.decisionId },
          ext ?? dialed,
          inputs
        );
      }
      if (owner.kind === 'parking' || owner.kind === 'menu') {
        // A parked call is retrieved by dialling its slot, not added to another conversation,
        // and a menu answers nobody but plays to its caller.
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
