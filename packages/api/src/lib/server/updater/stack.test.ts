import { readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, onTestFinished } from 'vitest';

import { createStack, verdictOn } from './stack.js';
import { parseVersion } from './version.js';

async function reported(report: unknown): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'zamfono-update-'));
  onTestFinished(() => rm(dir, { recursive: true, force: true }));
  await writeFile(path.join(dir, 'stack.json'), JSON.stringify(report));
  return dir;
}

describe('createStack', () => {
  it('reads the release, edge, or none, as the host agent reported them', async () => {
    const stack = createStack(
      await reported({ current: '0.0.6', pending: null })
    );
    expect(await stack.currentVersion()).toEqual([0, 0, 6]);
    expect(await stack.checkUpdate('0.0.7')).toBe('update');
    expect(
      await createStack(await reported({ current: 'edge' })).currentVersion()
    ).toBe('edge');
    expect(
      await createStack(await reported({ current: null })).currentVersion()
    ).toBeUndefined();
  });

  it("fails with update.sh's reason, and while there is no report", async () => {
    const failed = createStack(
      await reported({ current: null, error: 'ZAMFONO_VERSION=x is no tag' })
    );
    await expect(failed.currentVersion()).rejects.toThrow(
      'update.sh --current failed: ZAMFONO_VERSION=x is no tag'
    );
    await expect(
      createStack(path.join(tmpdir(), 'zamfono-none')).currentVersion()
    ).rejects.toThrow();
  });
});

/** update.sh --check's cases, which deploy/update-check-test.sh runs the script on: the policy
 * is the same in both. */
const CASES = readFileSync(
  new URL('../../../../../../deploy/update-check-cases.txt', import.meta.url),
  'utf8'
)
  .split('\n')
  .filter(line => line !== '' && !line.startsWith('#'))
  .map(line => line.split(' ') as [string, string, string]);
const VERDICTS: Record<string, string> = {
  '0': 'update',
  '10': 'breaking',
  '11': 'notNewer'
};

describe('verdictOn', () => {
  it.each(CASES)(
    'judges %s to %s as update.sh --check does (%s)',
    (from, to, status) => {
      const current = parseVersion(from);
      expect(current).toBeDefined();
      expect(verdictOn(current, undefined, to)).toBe(VERDICTS[status]);
    }
  );

  it('calls a new major breaking from 1.0.0 on, and a new minor not', () => {
    expect(verdictOn([1, 2, 3], undefined, '1.3.0')).toBe('update');
    expect(verdictOn([1, 2, 3], undefined, '2.0.0')).toBe('breaking');
    expect(verdictOn([0, 9, 1], undefined, '1.0.0')).toBe('breaking');
  });

  it('finishes an update that stopped before its stack reported healthy', () => {
    expect(verdictOn([0, 0, 7], '0.0.7', '0.0.7')).toBe('update');
    expect(verdictOn([0, 0, 7], '0.0.6', '0.0.7')).toBe('notNewer');
  });

  it('takes an edge stack to edge alone, and a directory without a release nowhere', () => {
    expect(verdictOn('edge', undefined, 'edge')).toBe('update');
    expect(() => verdictOn('edge', undefined, '0.0.7')).toThrow('follows edge');
    expect(verdictOn(undefined, undefined, '0.0.7')).toBe('noRelease');
  });
});
