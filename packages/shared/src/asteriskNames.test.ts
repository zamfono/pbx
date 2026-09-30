import { describe, expect, it } from 'vitest';

import {
  presenceHintDevice,
  TRUNK_SECTION_PREFIX,
  trunkSectionName
} from './asteriskNames.js';

describe('asteriskNames', () => {
  it('names a trunk section trunk-<id>', () => {
    expect(trunkSectionName('t1')).toBe('trunk-t1');
    expect(trunkSectionName('t1').startsWith(TRUNK_SECTION_PREFIX)).toBe(true);
  });

  it('names an extension hint device Stasis:presence-<ext>', () => {
    expect(presenceHintDevice('101')).toBe('Stasis:presence-101');
  });
});
