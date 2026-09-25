/**
 * Routing pipeline step 6, "Target menu" (spec §10.1): DTMF collection against a menu's map.
 * Pure functions only: the pipeline drives the inter-digit timer and greeting playback itself.
 */

export type MenuMap = { digits: string; targetId: string }[];

/** Seconds a menu waits for a further key before resolving what has been typed so far (§10.1). */
export const INTER_DIGIT_TIMEOUT_MS = 2000;

/**
 * Resolves `typed` against `map` (§10.1 "Target menu"): a string that still prefixes a longer
 * mapped one waits for another key, unless `timedOut`, in which case an exact match on `typed`
 * resolves and anything else does not; a string no mapped entry extends resolves at once, matched
 * or not.
 */
export function menuStep(
  map: MenuMap,
  typed: string,
  timedOut: boolean
):
  { kind: 'wait' } | { kind: 'match'; targetId: string } | { kind: 'nomatch' } {
  const exact = map.find(entry => entry.digits === typed);
  const extendedByLonger = map.some(
    entry => entry.digits !== typed && entry.digits.startsWith(typed)
  );
  if (!extendedByLonger) {
    return exact === undefined
      ? { kind: 'nomatch' }
      : { kind: 'match', targetId: exact.targetId };
  }
  if (!timedOut) {
    return { kind: 'wait' };
  }
  return exact === undefined
    ? { kind: 'nomatch' }
    : { kind: 'match', targetId: exact.targetId };
}
