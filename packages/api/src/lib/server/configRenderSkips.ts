import pino from 'pino';

import type { SkippedRow } from './pjsip/skippedRows.js';

const log = pino({ name: 'propagation' });

let latest: readonly SkippedRow[] = [];

function keyOf(row: SkippedRow): string {
  return `${row.type}:${row.id}:${row.field}`;
}

/**
 * The rows the latest render left out of the generated config (§3.1 "Config propagation"), `[]`
 * before the first render since `api` started.
 */
export function skippedConfigRows(): readonly SkippedRow[] {
  return latest;
}

/** Records the rows the latest render left out, logging each one the render before kept. */
export function recordSkippedConfigRows(rows: readonly SkippedRow[]): void {
  const before = new Set(latest.map(keyOf));
  for (const row of rows) {
    if (!before.has(keyOf(row))) {
      log.warn(
        { type: row.type, id: row.id, field: row.field },
        'config render: left out a row whose value cannot be written into the config'
      );
    }
  }
  latest = rows;
}
