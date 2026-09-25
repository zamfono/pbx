import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * `skills/zamfono/reference/tools.md` is generated from the operations registry by
 * `packages/api/scripts/tool-catalog.mjs`, and SKILL.md tells its reader the catalog never drifts
 * from the registry (§12 "Admin skill"). Nothing regenerates it on a build, so this is what makes
 * that claim true: a registered operation that never reached the committed file fails here.
 */
const REPO_ROOT = path.resolve(import.meta.dirname, '../../../../..');
const CATALOG = path.join(REPO_ROOT, 'skills/zamfono/reference/tools.md');
const GENERATOR = path.join(REPO_ROOT, 'packages/api/scripts/tool-catalog.mjs');

describe('the generated tool catalog', () => {
  it('matches the operations registry', () => {
    const generated = execFileSync('node', [GENERATOR], {
      cwd: REPO_ROOT,
      encoding: 'utf8'
    });
    const committed = readFileSync(CATALOG, 'utf8');

    expect(committed.trimEnd()).toBe(generated.trimEnd());
  });
});
