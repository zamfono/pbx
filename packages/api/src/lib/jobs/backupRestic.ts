/**
 * The restic commands a backup run issues (§6.5): reading the snapshot id and size from
 * `restic backup --json`, and applying the target's keep-daily/weekly/monthly policy with
 * `restic forget --prune`. `backup.ts` holds the run lifecycle around them.
 */
import process from 'node:process';
import pino from 'pino';

import { DEFAULT_FORGET_POLICY } from '../ops/backups/_shared.js';
import type { ExecFn, Params } from './backupBackends.js';

const logger = pino({ name: 'backup' });
export const RESTIC_BIN = 'restic';

type Summary = { snapshotId: string; bytes: number };

export function parseResticSummary(stdout: string): Summary {
  const lines = stdout.split('\n').filter(line => line.trim() !== '');
  for (const line of lines.toReversed()) {
    const parsed = JSON.parse(line) as Record<string, unknown>;
    if (
      parsed.message_type !== 'summary' ||
      typeof parsed.snapshot_id !== 'string'
    ) {
      continue;
    }
    return {
      snapshotId: parsed.snapshot_id,
      bytes: typeof parsed.data_added === 'number' ? parsed.data_added : 0
    };
  }
  throw new Error('backup: restic produced no summary line');
}

// restic's forget flags, by the matching key in `params.forget` (§6.5's default policy).
const KEEP_POLICY: readonly (readonly [string, string])[] = [
  ['--keep-daily', 'keepDaily'],
  ['--keep-weekly', 'keepWeekly'],
  ['--keep-monthly', 'keepMonthly']
];

/**
 * Forgets and prunes `params.forget`'s expired snapshots, with the backend's restic `options`;
 * best-effort, logged on failure.
 */
export async function pruneSnapshots(
  exec: ExecFn,
  env: Record<string, string>,
  options: readonly string[],
  params: Params
): Promise<void> {
  const forget = (params.forget ?? DEFAULT_FORGET_POLICY) as Record<
    string,
    unknown
  >;
  const args = ['forget', '--prune'];
  for (const [flag, key] of KEEP_POLICY) {
    // Admin-supplied and only shape-checked upstream (`params_json` is `z.record(z.unknown())`),
    // so a non-integer value falls back to the default instead of shipping `--keep-* NaN`.
    const raw = forget[key];
    const value =
      typeof raw === 'number' && Number.isInteger(raw) && raw >= 0
        ? raw
        : DEFAULT_FORGET_POLICY[key];
    args.push(flag, String(value));
  }
  args.push(...options);
  const fullEnv = { ...process.env, ...env };
  // Best-effort: the backup itself already succeeded, but a repository that stops pruning
  // (lock contention, credentials, full disk) needs a trace somewhere.
  await exec(RESTIC_BIN, args, { env: fullEnv }).catch((error: unknown) => {
    logger.warn({ error }, 'restic forget --prune failed');
  });
}
