import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { catalogLines } from './catalog.js';

/**
 * `skills/zamfono/reference/tools.md` is `catalogLines()` written out, and SKILL.md tells its
 * reader the catalog never drifts from the registry (§12 "Admin skill"). This file snapshot is
 * what makes that claim true: a registered operation that never reached the committed file fails
 * here, and `vitest run catalogDrift -u` (`scripts/build-skill.sh`) rewrites it.
 */
const CATALOG = path.resolve(
  import.meta.dirname,
  '../../../../../../skills/zamfono/reference/tools.md'
);

describe('the generated tool catalog', () => {
  it('matches the operations registry', async () => {
    await expect(`${catalogLines().join('\n')}\n`).toMatchFileSnapshot(CATALOG);
  });
});
