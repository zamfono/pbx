import { z } from 'zod';

const FEATURE_CODE_KEYS = [
  'pickup',
  'dndOn',
  'dndOff',
  'mailbox',
  'ownVoicemail',
  'deposit',
  'addParty',
  'clirOn',
  'clirOff',
  'park'
] as const;
export type FeatureCodeKey = (typeof FEATURE_CODE_KEYS)[number];

/**
 * A full set of feature codes: every key present as a string starting with `*` or `#`, and no
 * code a prefix of another, since Stasis resolves a dialled string by its longest matching code
 * (§9.3).
 */
export const featureCodesSchema = z
  .record(
    z.enum(FEATURE_CODE_KEYS),
    z.string().regex(/^[*#]/u, 'must start with * or #')
  )
  .superRefine((codes, ctx) => {
    for (const key of FEATURE_CODE_KEYS) {
      for (const otherKey of FEATURE_CODE_KEYS) {
        if (key !== otherKey && codes[otherKey].startsWith(codes[key])) {
          ctx.addIssue({
            code: 'custom',
            path: [otherKey],
            message: `'${codes[key]}' (${key}) is a prefix of '${codes[otherKey]}' (${otherKey})`
          });
        }
      }
    }
  });
export type FeatureCodes = z.infer<typeof featureCodesSchema>;

/** Codes dialled with an extension or number appended (§9.3 table). */
export const CODES_WITH_ARGUMENT: ReadonlySet<FeatureCodeKey> = new Set([
  'pickup',
  'mailbox',
  'deposit',
  'addParty',
  'clirOn',
  'clirOff'
]);

/** The longest configured code that matches `dialed`, with the remainder after it, or null
 * (§9.3): a code taking an argument prefixes it, one dialled alone equals it. */
export function matchFeatureCode(
  codes: FeatureCodes,
  dialed: string
): { key: FeatureCodeKey; rest: string } | null {
  const matching = FEATURE_CODE_KEYS.filter(key =>
    CODES_WITH_ARGUMENT.has(key)
      ? dialed.startsWith(codes[key])
      : dialed === codes[key]
  );
  if (matching.length === 0) {
    return null;
  }
  const longest = matching.reduce((best, key) =>
    codes[key].length > codes[best].length ? key : best
  );
  return {
    key: longest,
    rest: CODES_WITH_ARGUMENT.has(longest)
      ? dialed.slice(codes[longest].length)
      : ''
  };
}
