import { describe, expect, it } from 'vitest';

import {
  compareVersions,
  isBreaking,
  judgeUpdate,
  parseVersion,
  type Version
} from './policy.js';

function version(text: string): Version {
  const parsed = parseVersion(text);
  if (parsed === undefined) {
    throw new Error(`not a version: ${text}`);
  }
  return parsed;
}

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
});

describe('compareVersions', () => {
  it('orders by number, not by text', () => {
    expect(
      compareVersions(version('0.0.10'), version('0.0.9'))
    ).toBeGreaterThan(0);
    expect(compareVersions(version('1.0.0'), version('0.9.9'))).toBeGreaterThan(
      0
    );
    expect(compareVersions(version('0.1.0'), version('0.1.0'))).toBe(0);
  });
});

describe('isBreaking', () => {
  it('while 0.x, a new minor is breaking and a new patch is not', () => {
    expect(isBreaking(version('0.0.5'), version('0.0.6'))).toBe(false);
    expect(isBreaking(version('0.0.6'), version('0.1.0'))).toBe(true);
  });

  it('from 1.0.0 on, only a new major is breaking', () => {
    expect(isBreaking(version('1.2.3'), version('1.9.0'))).toBe(false);
    expect(isBreaking(version('1.9.0'), version('2.0.0'))).toBe(true);
    expect(isBreaking(version('0.9.0'), version('1.0.0'))).toBe(true);
  });
});

describe('judgeUpdate', () => {
  it('allows a newer non-breaking release', () => {
    expect(judgeUpdate(version('0.0.5'), version('0.0.7'))).toEqual({
      ok: true
    });
  });

  it('refuses the same or an older release', () => {
    expect(judgeUpdate(version('0.0.6'), version('0.0.6'))).toMatchObject({
      ok: false,
      reason: 'notNewer'
    });
    expect(judgeUpdate(version('0.0.6'), version('0.0.5'))).toMatchObject({
      ok: false,
      reason: 'notNewer'
    });
  });

  it('refuses a breaking release, naming update.sh', () => {
    const verdict = judgeUpdate(version('0.0.6'), version('0.1.0'));
    expect(verdict).toMatchObject({ ok: false, reason: 'breaking' });
    expect(verdict.ok ? '' : verdict.message).toContain('update.sh');
  });
});
