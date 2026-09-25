import { describe, expect, it } from 'vitest';

import {
  SIT_DURATION_MS,
  SPECIAL_INFORMATION_TONE_MEDIA
} from './indications.js';

describe('SPECIAL_INFORMATION_TONE_MEDIA', () => {
  it('renders the info tone name in the itu zone as a tone: reference', () => {
    expect(SPECIAL_INFORMATION_TONE_MEDIA).toBe('tone:info;tonezone=itu');
  });
});

describe('SIT_DURATION_MS', () => {
  it('covers three repeats of the special information tone (three 330 ms segments plus 1000 ms silence)', () => {
    expect(SIT_DURATION_MS).toBe(3 * (3 * 330 + 1000));
  });
});
