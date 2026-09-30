import { readFileSync } from 'node:fs';
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

/** deploy/update-policy.tsv: the rows update.sh is tested against too (deploy/update-test.sh). */
type Case = { from: string; to: string; verdict: string };

function policyTable(): Case[] {
  const url = new URL('../../../deploy/update-policy.tsv', import.meta.url);
  return readFileSync(url, 'utf8')
    .split('\n')
    .filter(line => line !== '' && !line.startsWith('#'))
    .map(line => {
      const [from = '', to = '', verdict = ''] = line.split('\t');
      return { from, to, verdict };
    });
}

describe('judgeUpdate, against deploy/update-policy.tsv', () => {
  const table = policyTable();

  it('reads a table that has every verdict', () => {
    expect(new Set(table.map(row => row.verdict))).toEqual(
      new Set(['same', 'older', 'update', 'breaking'])
    );
  });

  it.each(table)(
    '$from to $to: $verdict',
    ({ from: fromText, to: toText, verdict }) => {
      const from = version(fromText);
      const to = version(toText);
      const judged = judgeUpdate(from, to);
      switch (verdict) {
        case 'same':
        case 'older':
          expect(judged).toMatchObject({ ok: false, reason: 'notNewer' });
          expect(compareVersions(to, from) === 0).toBe(verdict === 'same');
          break;
        case 'update':
          expect(judged).toEqual({ ok: true });
          expect(isBreaking(from, to)).toBe(false);
          break;
        case 'breaking':
          expect(judged).toMatchObject({ ok: false, reason: 'breaking' });
          expect(isBreaking(from, to)).toBe(true);
          break;
        default:
          throw new Error(`update-policy.tsv: unknown verdict ${verdict}`);
      }
    }
  );

  it('names update.sh when it refuses a breaking release', () => {
    const verdict = judgeUpdate(version('0.0.6'), version('0.1.0'));
    expect(verdict.ok ? '' : verdict.message).toContain('update.sh');
  });
});
