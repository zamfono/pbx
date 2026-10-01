// Side-effect import: fills the registry (§10.3) every area's own operations register into, so
// the catalog below reflects every operation regardless of what else has run first.
import './index.js';

import { routes } from '../restRoutes.js';
import { registry } from './registry.js';

/** The REST endpoints (§10.3) that reach `op`, or a dash for an operation only MCP and the UI call. */
function restColumn(op: string): string {
  const endpoints = routes
    .filter(route => route.op === op)
    .map(route => `\`${route.method} ${route.pattern}\``);
  return endpoints.length === 0 ? '—' : endpoints.join(', ');
}

/**
 * A Markdown table of every registered operation, one row per name, sorted the same way
 * `listTools` orders `tools/list` (§10.5): code-point order, not `localeCompare`, so the table is
 * stable across regenerations regardless of the container's ICU locale. Backs
 * `skills/zamfono/reference/tools.md` (§12 "Admin skill"), generated instead of
 * hand-written so it cannot drift from `registry` or the REST route table. The operation name is
 * the MCP tool's name (§10.5).
 */
export function catalogLines(): string[] {
  const header = [
    '| Operation (MCP tool) | REST | Description | Min role | Confirm |',
    '| --- | --- | --- | --- | --- |'
  ];
  const rows = [...registry.values()]
    .sort(
      (left, right) =>
        Number(left.name > right.name) - Number(left.name < right.name)
    )
    .map(
      op =>
        `| \`${op.name}\` | ${restColumn(op.name)} | ${op.description} | ${op.minRole} | ${op.confirm ? 'yes' : 'no'} |`
    );
  return [...header, ...rows];
}
