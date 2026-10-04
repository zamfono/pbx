import { describe, expect, test } from 'vitest';

import { featureCodesSchema, matchFeatureCode } from './featureCodes.js';
import { defaultFeatureCodes } from './testDb.js';

const DEFAULTS = await defaultFeatureCodes();

describe('featureCodesSchema', () => {
  test('the column default is valid and prefix-free', () => {
    expect(featureCodesSchema.parse(DEFAULTS)).toEqual(DEFAULTS);
  });

  test('prefix collision refused', () => {
    expect(() => featureCodesSchema.parse({ ...DEFAULTS, park: '*9' })).toThrow(
      /prefix/u
    );
  });

  test('must start with * or #', () => {
    expect(() => featureCodesSchema.parse({ ...DEFAULTS, park: '70' })).toThrow(
      /start/u
    );
  });

  test('every key required, no other key accepted', () => {
    const missing: Partial<typeof DEFAULTS> = { ...DEFAULTS };
    delete missing.park;
    expect(featureCodesSchema.safeParse(missing).success).toBe(false);
    expect(
      featureCodesSchema.safeParse({ ...DEFAULTS, intercom: '*6' }).success
    ).toBe(false);
  });
});

describe('matchFeatureCode', () => {
  test('longest match', () => {
    expect(matchFeatureCode(DEFAULTS, '*95101')).toEqual({
      key: 'mailbox',
      rest: '101'
    });
    expect(matchFeatureCode(DEFAULTS, '*90')).toEqual({
      key: 'dndOn',
      rest: ''
    });
    expect(matchFeatureCode(DEFAULTS, '#31#0891')).toEqual({
      key: 'clirOn',
      rest: '0891'
    });
    expect(matchFeatureCode(DEFAULTS, '101')).toBeNull();
  });

  test('a code dialled alone matches only exactly, never with trailing digits (§9.3)', () => {
    expect(matchFeatureCode(DEFAULTS, '*901234')).toBeNull();
    expect(matchFeatureCode(DEFAULTS, '*91')).toEqual({
      key: 'dndOff',
      rest: ''
    });
    expect(matchFeatureCode(DEFAULTS, '*9612')).toBeNull();
    expect(matchFeatureCode(DEFAULTS, '*7099')).toBeNull();
  });
});
