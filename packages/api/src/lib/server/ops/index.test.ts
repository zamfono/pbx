import { describe, expect, it } from 'vitest';

import { registry } from './registry.js';

import './index.js';

// Each area's own index.ts registers on import; this only guards the aggregator in ops/index.ts
// itself, which every task must extend with its own import line (see the comment there).
describe('ops/index', () => {
  it('registers provisioning.ringotelSetup', () => {
    expect(registry.has('provisioning.ringotelSetup')).toBe(true);
  });
});
