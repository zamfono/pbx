import { describe, expect, test } from 'vitest';

import {
  DEFAULT_FEATURE_CODES,
  matchFeatureCode,
  validateFeatureCodes
} from './featureCodes.js';

describe('validateFeatureCodes', () => {
  test('defaults are valid and prefix-free', () => {
    expect(validateFeatureCodes(DEFAULT_FEATURE_CODES)).toEqual(
      DEFAULT_FEATURE_CODES
    );
  });

  test('prefix collision refused', () => {
    expect(() =>
      validateFeatureCodes({ ...DEFAULT_FEATURE_CODES, park: '*9' })
    ).toThrow(/prefix/u);
  });

  test('must start with * or #', () => {
    expect(() =>
      validateFeatureCodes({ ...DEFAULT_FEATURE_CODES, park: '70' })
    ).toThrow(/start/u);
  });
});

describe('matchFeatureCode', () => {
  test('longest match', () => {
    expect(matchFeatureCode(DEFAULT_FEATURE_CODES, '*95101')).toEqual({
      key: 'mailbox',
      rest: '101'
    });
    expect(matchFeatureCode(DEFAULT_FEATURE_CODES, '*90')).toEqual({
      key: 'dndOn',
      rest: ''
    });
    expect(matchFeatureCode(DEFAULT_FEATURE_CODES, '#31#0891')).toEqual({
      key: 'clirOn',
      rest: '0891'
    });
    expect(matchFeatureCode(DEFAULT_FEATURE_CODES, '101')).toBeNull();
  });

  test('no-argument code ignores trailing digits', () => {
    expect(matchFeatureCode(DEFAULT_FEATURE_CODES, '*901')).toEqual({
      key: 'dndOn',
      rest: ''
    });
  });
});
