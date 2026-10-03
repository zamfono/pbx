/**
 * "Outbound" (spec §10.1, steps 1-6, "Emergency calls"): resolves a dialled string into the
 * action the pipeline takes next. Pure function only: trunk selection, CLIR presentation and the
 * actual dial happen downstream (§9.4, `trunk.ts`).
 */

import {
  matchFeatureCode,
  normalizeDialed,
  type FeatureCodeKey,
  type FeatureCodes
} from '@zamfono/shared';

import { SIP_ADDRESS_INCOMPLETE, SIP_NOT_FOUND } from '../sipCodes.js';

type ExtensionOwner =
  | { kind: 'user'; userId: string }
  | { kind: 'ringGroup'; ringGroupId: string }
  | { kind: 'parking'; ext: string };

export type DialAction =
  | { kind: 'feature'; key: FeatureCodeKey; rest: string; clir: boolean | null }
  | { kind: 'emergency'; number: string }
  | { kind: 'extension'; owner: ExtensionOwner; clir: boolean | null }
  | {
      kind: 'ownDid';
      didId: string;
      number: string;
      targetId: string;
      clir: boolean | null;
    }
  | { kind: 'external'; number: string; clir: boolean | null }
  | {
      kind: 'refuse';
      code: typeof SIP_NOT_FOUND | typeof SIP_ADDRESS_INCOMPLETE;
    };

export type ExtensionRow = {
  userId: string | null;
  ringGroupId: string | null;
  isParkingSlot: boolean;
};

export type ResolveDialedContext = {
  featureCodes: FeatureCodes;
  emergencyNumbers: string[];
  country: string;
  extLength: number;
  extensions: Map<string, ExtensionRow>;
  dids: Map<string, { id: string; targetId: string }>;
};

/** The `ExtensionOwner` a live `extensions` row represents (§11.2 `extensions`). */
function ownerFromRow(ext: string, row: ExtensionRow): ExtensionOwner {
  if (row.isParkingSlot) {
    return { kind: 'parking', ext };
  }
  if (row.userId !== null) {
    return { kind: 'user', userId: row.userId };
  }
  if (row.ringGroupId !== null) {
    return { kind: 'ringGroup', ringGroupId: row.ringGroupId };
  }
  throw new Error(`resolveDialed: extension "${ext}" owns nothing`);
}

/** Sets `clir` on `action` for the kinds that carry it, unchanged for `emergency` and `refuse` (§10.1 Outbound step 1). */
export function withClir(action: DialAction, clir: boolean): DialAction {
  switch (action.kind) {
    case 'feature':
    case 'extension':
    case 'ownDid':
    case 'external':
      return { ...action, clir };
    default:
      return action;
  }
}

/**
 * Resolves a dialled string in the order of §10.1 "Outbound" steps 1-5: a feature code (the CLIR
 * prefixes strip themselves and recurse on the remainder), an emergency number, a live extension
 * or parking slot, a normalized E.164 address, one of the tenant's own DIDs, else an external
 * number.
 */
export function resolveDialed(
  dialed: string,
  ctx: ResolveDialedContext
): DialAction {
  const feature = matchFeatureCode(ctx.featureCodes, dialed);
  if (feature !== null) {
    if (feature.key === 'clirOn' || feature.key === 'clirOff') {
      return withClir(
        resolveDialed(feature.rest, ctx),
        feature.key === 'clirOn'
      );
    }
    return {
      kind: 'feature',
      key: feature.key,
      rest: feature.rest,
      clir: null
    };
  }
  if (ctx.emergencyNumbers.includes(dialed)) {
    return { kind: 'emergency', number: dialed };
  }
  if (dialed.length <= ctx.extLength) {
    const row = ctx.extensions.get(dialed);
    if (row === undefined) {
      return { kind: 'refuse', code: SIP_NOT_FOUND };
    }
    return { kind: 'extension', owner: ownerFromRow(dialed, row), clir: null };
  }
  const normalized = normalizeDialed(dialed, ctx.country);
  if (normalized.kind === 'incomplete') {
    return { kind: 'refuse', code: SIP_ADDRESS_INCOMPLETE };
  }
  const did = ctx.dids.get(normalized.number);
  if (did !== undefined) {
    return {
      kind: 'ownDid',
      didId: did.id,
      number: normalized.number,
      targetId: did.targetId,
      clir: null
    };
  }
  return { kind: 'external', number: normalized.number, clir: null };
}
