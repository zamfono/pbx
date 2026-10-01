import { describe, expect, it } from 'vitest';

import { formatVersion, parseVersion } from './version.js';

describe('parseVersion', () => {
  it('reads X.Y.Z, with or without a leading v', () => {
    expect(parseVersion('0.0.6')).toEqual([0, 0, 6]);
    expect(parseVersion('v1.12.3')).toEqual([1, 12, 3]);
  });

  it('refuses anything else', () => {
    for (const text of ['latest', '1.2', '1.2.3-rc.1', ' 1.2.3', '']) {
      expect(parseVersion(text)).toBeUndefined();
    }
  });

  it('writes a version back as X.Y.Z', () => {
    expect(formatVersion([1, 12, 3])).toBe('1.12.3');
  });
});
