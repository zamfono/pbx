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

export type FeatureCodes = Record<FeatureCodeKey, string>;

/** Column default of `settings.feature_codes_json` (§9.3 table). */
export const DEFAULT_FEATURE_CODES: FeatureCodes = {
  pickup: '*8',
  dndOn: '*90',
  dndOff: '*91',
  mailbox: '*95',
  ownVoicemail: '*96',
  deposit: '*97',
  addParty: '*5',
  clirOn: '#31#',
  clirOff: '*31#',
  park: '*70'
};

/** Codes dialled with an extension or number appended (§9.3 table). */
export const CODES_WITH_ARGUMENT: ReadonlySet<FeatureCodeKey> = new Set([
  'pickup',
  'mailbox',
  'deposit',
  'addParty',
  'clirOn',
  'clirOff'
]);

/**
 * Validates a full set of feature codes: every key present as a string starting with `*` or `#`,
 * and no code a prefix of another, since Stasis resolves a dialled string by its longest matching
 * code (§9.3).
 */
export function validateFeatureCodes(codes: unknown): FeatureCodes {
  if (typeof codes !== 'object' || codes === null) {
    throw new Error('featureCodes: not an object');
  }
  const input = codes as Record<string, unknown>;
  const result = {} as FeatureCodes;
  for (const key of FEATURE_CODE_KEYS) {
    const value = input[key];
    if (typeof value !== 'string') {
      throw new Error(`featureCodes: missing key '${key}'`);
    }
    if (!value.startsWith('*') && !value.startsWith('#')) {
      throw new Error(`featureCodes: '${key}' must start with * or #`);
    }
    result[key] = value;
  }
  FEATURE_CODE_KEYS.forEach(key => {
    FEATURE_CODE_KEYS.forEach(otherKey => {
      if (key !== otherKey && result[otherKey].startsWith(result[key])) {
        throw new Error(
          `featureCodes: '${result[key]}' (${key}) is a prefix of '${result[otherKey]}' (${otherKey})`
        );
      }
    });
  });
  return result;
}

/** The longest configured code that prefixes `dialed`, with the remainder after it, or null (§9.3). */
export function matchFeatureCode(
  codes: FeatureCodes,
  dialed: string
): { key: FeatureCodeKey; rest: string } | null {
  const matching = FEATURE_CODE_KEYS.filter(key =>
    dialed.startsWith(codes[key])
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
