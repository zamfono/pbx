import { describe, expect, it } from 'vitest';

import type { ExecFn } from './backupBackends.js';
import { ensureRepository, parseResticSummary } from './backupRestic.js';

type Call = string[];

/** An exec whose `restic cat config` fails with `catConfigCode`, recording every argv. */
function resticWithout(catConfigCode: number | undefined): {
  exec: ExecFn;
  calls: Call[];
} {
  const calls: Call[] = [];
  const exec: ExecFn = (_file, args) => {
    calls.push([...args]);
    if (args[0] === 'cat' && catConfigCode !== undefined) {
      return Promise.reject(
        Object.assign(new Error(`restic exited ${catConfigCode}`), {
          code: catConfigCode
        })
      );
    }
    return Promise.resolve({ stdout: '', stderr: '' });
  };
  return { exec, calls };
}

const OPTIONS = ['-o', 'sftp.command=ssh'];
const NO_REPOSITORY = 10;
const WRONG_PASSWORD = 12;

describe('ensureRepository', () => {
  it('leaves an existing repository alone', async () => {
    const { exec, calls } = resticWithout(undefined);
    await ensureRepository(exec, {}, OPTIONS);
    expect(calls).toEqual([['cat', 'config', ...OPTIONS]]);
  });

  it('initializes the repository a new target does not have yet', async () => {
    const { exec, calls } = resticWithout(NO_REPOSITORY);
    await ensureRepository(exec, {}, OPTIONS);
    expect(calls).toEqual([
      ['cat', 'config', ...OPTIONS],
      ['init', ...OPTIONS]
    ]);
  });

  it('fails on a repository it cannot open, and initializes nothing over it', async () => {
    const { exec, calls } = resticWithout(WRONG_PASSWORD);
    await expect(ensureRepository(exec, {}, OPTIONS)).rejects.toThrow(
      'restic exited 12'
    );
    expect(calls).toEqual([['cat', 'config', ...OPTIONS]]);
  });
});

// `restic backup --json` as restic 0.18.0, the api image's, printed it for a second snapshot of
// a directory: a status line, then the summary.
const RESTIC_OUTPUT = [
  '{"message_type":"status","percent_done":1,"total_files":2,"files_done":2,"total_bytes":301000,"bytes_done":301000}',
  '{"message_type":"summary","files_new":2,"files_changed":0,"files_unmodified":0,"dirs_new":2,"dirs_changed":0,"dirs_unmodified":0,"data_blobs":1,"tree_blobs":3,"data_added":2367,"data_added_packed":2024,"total_files_processed":2,"total_bytes_processed":301000,"total_duration":0.650219983,"backup_start":"2026-09-30T08:20:51.488346947Z","backup_end":"2026-09-30T08:20:52.13856687Z","snapshot_id":"a646a6946940f66165f074f958b7e4fe862982faae27b1ce42306fb2ba2fd5a7"}',
  ''
].join('\n');

describe('parseResticSummary', () => {
  it('reads the snapshot id, the bytes added and the snapshot’s total size (§6.5)', () => {
    expect(parseResticSummary(RESTIC_OUTPUT)).toEqual({
      snapshotId:
        'a646a6946940f66165f074f958b7e4fe862982faae27b1ce42306fb2ba2fd5a7',
      bytesAdded: 2367,
      bytesTotal: 301_000
    });
  });

  it('leaves a size the summary does not carry null rather than 0', () => {
    expect(
      parseResticSummary('{"message_type":"summary","snapshot_id":"s1"}')
    ).toEqual({ snapshotId: 's1', bytesAdded: null, bytesTotal: null });
  });

  it('throws without a summary that names a snapshot', () => {
    expect(() =>
      parseResticSummary(
        '{"message_type":"status","percent_done":1}\n{"message_type":"summary","data_added":0}'
      )
    ).toThrow(/no summary line/u);
  });
});
