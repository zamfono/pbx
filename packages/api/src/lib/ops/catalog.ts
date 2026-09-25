// Side-effect import: fills the registry (§10.3) every area's own operations register into, so
// the catalog below reflects every operation regardless of what else has run first.
import './index.js';

import { registry } from './registry.js';

/**
 * A Markdown table of every registered operation, one row per name, sorted the same way
 * `listTools` orders `tools/list` (§10.5): code-point order, not `localeCompare`, so the table is
 * stable across regenerations regardless of the container's ICU locale. Backs
 * `skills/zamfono/reference/tools.md` (§12 "Admin skill", Task 46), generated instead of
 * hand-written so it cannot drift from `registry`.
 */
export function catalogLines(): string[] {
  const header = [
    '| Operation | Description | Min role | Confirm |',
    '| --- | --- | --- | --- |'
  ];
  const rows = [...registry.values()]
    .sort(
      (left, right) =>
        Number(left.name > right.name) - Number(left.name < right.name)
    )
    .map(
      op =>
        `| \`${op.name}\` | ${op.description} | ${op.minRole} | ${op.confirm ? 'yes' : 'no'} |`
    );
  return [...header, ...rows];
}
