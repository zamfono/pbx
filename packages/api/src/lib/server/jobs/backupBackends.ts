/**
 * Restic repository string and backend env per `backup_targets.kind` (§6.5 "Target kinds"):
 * `local`, `s3` and `sftp` use restic's native backends; `ftp`, `ftps` and `webdav` go through
 * its rclone backend. `backup.ts` holds the run lifecycle; this file holds the per-kind
 * repository string and backend env.
 */
import path from 'node:path';
import process from 'node:process';
import * as privateEnv from '$app/env/private';

import type { BackupSecret } from '../ops/backups/_secret.js';
import type { BackupTargetRow } from '../ops/backups/_shared.js';

export type ExecFn = (
  file: string,
  args: readonly string[],
  // `input`, when given, is written to the child's stdin and the stream then closed, for a
  // credential that must not appear in argv (visible via `ps`, and echoed back into a
  // non-zero-exit error message).
  options: { env: NodeJS.ProcessEnv; input?: string }
) => Promise<{ stdout: string; stderr: string }>;

// The rclone remote name; its connection comes entirely from `RCLONE_CONFIG_<NAME>_*` env vars.
const RCLONE_REMOTE_NAME = 'zamfono';

export type Params = Record<string, unknown>;
function str(params: Params, key: string): string {
  const value = params[key];
  if (typeof value !== 'string' || value === '') {
    throw new Error(`backup: '${key}' must be a non-empty string`);
  }
  return value;
}

function optStr(params: Params, key: string): string | undefined {
  return typeof params[key] === 'string' ? params[key] : undefined;
}
export function loadParams(target: BackupTargetRow): Params {
  return JSON.parse(target.paramsJson) as Params;
}

type Credential = 'accessKeyId' | 'password' | 'secretAccessKey' | 'username';
function credential(
  secret: BackupSecret,
  field: Credential,
  kind: string
): string {
  const value = secret[field];
  if (!value) {
    throw new Error(`backup: ${kind} target needs a '${field}' credential`);
  }
  return value;
}

export type RepositoryAndEnv = {
  repository: string;
  env: Record<string, string>;
  // restic's `-o key=value` backend options, passed to every restic command of the run.
  options: string[];
};
type TargetKind = 'ftp' | 'ftps' | 'local' | 's3' | 'sftp' | 'webdav';

// rclone treats a backend password as obscured (its own reversible transform) and rejects a
// plain one, so every rclone credential is run through `rclone obscure` before export. Given no
// argument, `rclone obscure` reads the password from stdin, keeping it out of argv.
async function obscurePassword(
  exec: ExecFn,
  password: string
): Promise<string> {
  const { stdout } = await exec('rclone', ['obscure'], {
    env: process.env,
    input: password
  });
  return stdout.trim();
}

async function rcloneRepository(
  kind: 'ftp' | 'ftps' | 'webdav',
  params: Params,
  secret: BackupSecret,
  exec: ExecFn
): Promise<RepositoryAndEnv> {
  const prefix = `RCLONE_CONFIG_${RCLONE_REMOTE_NAME.toUpperCase()}`;
  const env: Record<string, string> = {
    [`${prefix}_TYPE`]: kind === 'webdav' ? 'webdav' : 'ftp',
    [`${prefix}_USER`]: credential(secret, 'username', kind),
    [`${prefix}_PASS`]: await obscurePassword(
      exec,
      credential(secret, 'password', kind)
    )
  };
  // webdav addresses its endpoint as a URL, not a host (unlike ftp/ftps).
  if (kind === 'webdav') {
    env[`${prefix}_URL`] = str(params, 'url');
  } else {
    env[`${prefix}_HOST`] = str(params, 'host');
    if (kind === 'ftps') {
      env[`${prefix}_EXPLICIT_TLS`] = 'true';
    }
  }
  return {
    repository: `rclone:${RCLONE_REMOTE_NAME}:${optStr(params, 'path') ?? ''}`,
    env,
    options: []
  };
}

// Next to the database on the `db` volume, so a host key accepted on first contact survives
// restarts and upgrades and a later change is refused (§6.3: `/data` is api's persistent state).
function sshKnownHostsFile(): string {
  const dbFile = privateEnv.DB_FILE;
  if (!dbFile) {
    throw new Error('backup: DB_FILE is required for an sftp target');
  }
  return path.join(path.dirname(dbFile), 'ssh_known_hosts');
}

/**
 * restic's native sftp backend spawns `ssh`; `sftp.command` replaces that command so the
 * password from `secret_enc` (§11.2 "the backend credentials") reaches ssh through `sshpass -e`,
 * which reads it from `SSHPASS` rather than argv. Nothing in the target model carries a host key,
 * and ssh's default (ask) fails without a terminal, so the first contact's key is accepted and
 * pinned in `sshKnownHostsFile()`.
 */
function sftpRepository(
  params: Params,
  secret: BackupSecret
): RepositoryAndEnv {
  const host = str(params, 'host');
  const user = credential(secret, 'username', 'sftp');
  const command = [
    'sshpass -e ssh',
    '-o StrictHostKeyChecking=accept-new',
    `-o UserKnownHostsFile=${sshKnownHostsFile()}`,
    `-l ${user} ${host} -s sftp`
  ].join(' ');
  return {
    repository: `sftp:${user}@${host}:${str(params, 'path')}`,
    env: { SSHPASS: credential(secret, 'password', 'sftp') },
    options: ['-o', `sftp.command=${command}`]
  };
}

/** The restic repository string and backend env for `target.kind` (§6.5 "Target kinds"). */
export async function repositoryAndEnv(
  target: BackupTargetRow,
  secret: BackupSecret,
  exec: ExecFn
): Promise<RepositoryAndEnv> {
  const params = loadParams(target);
  const kind = target.kind as TargetKind;
  switch (kind) {
    case 'local':
      return { repository: str(params, 'path'), env: {}, options: [] };
    case 's3': {
      const prefix = optStr(params, 'path');
      const suffix = prefix === undefined ? '' : `/${prefix}`;
      return {
        repository: `s3:${str(params, 'endpoint')}/${str(params, 'bucket')}${suffix}`,
        env: {
          AWS_ACCESS_KEY_ID: credential(secret, 'accessKeyId', 's3'),
          AWS_SECRET_ACCESS_KEY: credential(secret, 'secretAccessKey', 's3')
        },
        options: []
      };
    }
    case 'sftp':
      return sftpRepository(params, secret);
    case 'ftp':
    case 'ftps':
    case 'webdav':
      return rcloneRepository(kind, params, secret, exec);
    default:
      throw new Error(`backup: unknown target kind '${String(kind)}'`);
  }
}
