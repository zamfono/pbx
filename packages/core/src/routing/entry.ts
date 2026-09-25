/**
 * Routing pipeline step 1, "Entry" (spec §10.1): caller screening against the tenant blocklist,
 * inbound DID and number-block resolution, and the withheld-caller check against a target's
 * `reject_anonymous` (§9.4 "Withheld caller", §11.2 `blocked_numbers`, §11.3 "Number blocks").
 */

/** The literal caller value of a call whose number is absent or withheld (§9.4). */
const ANONYMOUS_CALLER = 'anonymous';

/** Whether `caller` matches an entry of `blocklist`; a withheld caller never matches (§9.4). */
export function isBlocked(
  caller: string,
  blocklist: { number: string; isPrefix: boolean }[]
): boolean {
  if (caller === ANONYMOUS_CALLER) {
    return false;
  }
  return blocklist.some(entry =>
    entry.isPrefix ? caller.startsWith(entry.number) : caller === entry.number
  );
}

/** Whether `called` falls within `block`'s base, and digit count when the block sets one. */
function coversNumber(
  called: string,
  block: { base: string; digits: number | null }
): boolean {
  if (!called.startsWith(block.base)) {
    return false;
  }
  return (
    block.digits === null || called.length === block.base.length + block.digits
  );
}

/** The most precise (longest-base) block covering `called`, else null (§11.3). */
function matchingBlock(
  called: string,
  blocks: {
    id: string;
    base: string;
    digits: number | null;
    fallbackTargetId: string | null;
  }[]
): { id: string; fallbackTargetId: string | null } | null {
  const covering = blocks.filter(block => coversNumber(called, block));
  if (covering.length === 0) {
    return null;
  }
  const widest = covering.reduce((longest, candidate) =>
    candidate.base.length > longest.base.length ? candidate : longest
  );
  return { id: widest.id, fallbackTargetId: widest.fallbackTargetId };
}

/** The release status for a called number outside every DID and block (§11.3). */
const RELEASE_CODE_NOT_FOUND = 404;

/**
 * Resolves an inbound `called` number, most precise match first: an exact `dids` row, else the
 * longest matching number block's fallback, else the tenant-wide fallback, else a 404 release
 * (§11.3).
 */
export function resolveInbound(
  called: string,
  dids: { id: string; number: string; targetId: string }[],
  blocks: {
    id: string;
    base: string;
    digits: number | null;
    fallbackTargetId: string | null;
  }[],
  tenantFallbackTargetId: string | null
):
  | { kind: 'did'; didId: string; targetId: string }
  | { kind: 'fallback'; targetId: string; blockId: string | null }
  // eslint-disable-next-line no-magic-numbers -- the release status a number outside every DID and block gets (§11.3)
  | { kind: 'release'; code: 404 } {
  const did = dids.find(row => row.number === called);
  if (did) {
    return { kind: 'did', didId: did.id, targetId: did.targetId };
  }
  const block = matchingBlock(called, blocks);
  const targetId = block?.fallbackTargetId ?? tenantFallbackTargetId;
  if (targetId === null) {
    return { kind: 'release', code: RELEASE_CODE_NOT_FOUND };
  }
  return { kind: 'fallback', targetId, blockId: block?.id ?? null };
}

/**
 * Whether a withheld `caller` is rejected by `target`'s own `reject_anonymous` (NULL inherits
 * `tenantDefault`); a caller presenting a number is never rejected here (§10.1, Entry).
 */
export function rejectAnonymous(
  caller: string,
  target: { rejectAnonymous: boolean | null },
  tenantDefault: boolean
): boolean {
  if (caller !== ANONYMOUS_CALLER) {
    return false;
  }
  return target.rejectAnonymous ?? tenantDefault;
}
