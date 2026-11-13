/**
 * Restic repository string and backend env per `backup_targets.kind` (§6.5 "Target kinds"):
 * `local`, `s3` and `sftp` use restic's native backends; `ftp`, `ftps` and `webdav` go through
 * its rclone backend. `backup.ts` holds the run lifecycle; this file holds the per-kind
 * repository string and backend env, and the check of a remote target's server against
 * `ALLOW_PRIVATE_TARGETS` and the stack's own network before any tool runs (§3.1 "Outbound
 * targets").
 */
import path from 'node:path';
import process from 'node:process';
import * as privateEnv from '$app/env/private';

import { backupParamsColumn, resolveTarget } from '@zamfono/shared';

import type { BackupSecret } from '../ops/backups/_secret.js';
import {
  assertLocalPath,
  serverOf,
  type BackupTargetRow
} from '../ops/backups/_shared.js';

export type ExecFn = (
  file: string,
  args: readonly string[],
  // `input`, when given, is written to the child's stdin and the stream then closed, for a
  // credential that must not appear in argv (visible via `ps`, and echoed back into a
  // non-zero-exit error message).
  options: { env: NodeJS.ProcessEnv; input?: string }
) => Promise<{ stdout: string; stderr: string }>;

// What restic, rclone, sshpass and ssh take from api's own environment: finding the binaries,
// their cache and config under HOME, a temp dir, the time zone snapshots are stamped in and the
// locale. Nothing else of it, SECRETBOX_KEY and JWT_SECRET least of all, reaches them (§6.5).
const INHERITED_ENV = ['PATH', 'HOME', 'TMPDIR', 'TZ', 'LANG', 'LC_ALL'];

/** `own` over the few variables of api's environment a backup tool needs (`INHERITED_ENV`). */
export function toolEnv(own: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of INHERITED_ENV) {
    const value = process.env[key];
    if (value !== undefined) {
      env[key] = value;
    }
  }
  return { ...env, ...own };
}

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
  return backupParamsColumn.decode(target.paramsJson);
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
// rclone treats a backend password as obscured (its own reversible transform) and rejects a
// plain one, so every rclone credential is run through `rclone obscure` before export. Given no
// argument, `rclone obscure` reads the password from stdin, keeping it out of argv.
async function obscurePassword(
  exec: ExecFn,
  password: string
): Promise<string> {
  const { stdout } = await exec('rclone', ['obscure'], {
    env: toolEnv({}),
    input: password
  });
  return stdout.trim();
}

async function rcloneRepository(
  kind: 'ftp' | 'ftps' | 'webdav',
  params: Params,
  secret: BackupSecret,
  exec: ExecFn,
  address: string
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
  } else if (kind === 'ftp') {
    // Plain ftp connects to the address checked; ftps keeps the name its certificate is checked
    // against.
    env[`${prefix}_HOST`] = address;
  } else {
    env[`${prefix}_HOST`] = str(params, 'host');
    env[`${prefix}_EXPLICIT_TLS`] = 'true';
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
  return path.join(path.dirname(privateEnv.DB_FILE), 'ssh_known_hosts');
}

// restic splits `sftp.command` into argv itself, without a shell (`SplitShellStrings`): outside
// quotes every whitespace and `\` separates words, and a `"…"` word ends at the next `"` that no
// `\` precedes. A value without `"` or `\` is therefore exactly one word once double-quoted.
function sshWord(value: string): string {
  if (/["\\]/u.test(value)) {
    throw new Error(
      'backup: an sftp host or username cannot contain a quote or a backslash'
    );
  }
  return `"${value}"`;
}

/**
 * restic's native sftp backend spawns `ssh`; `sftp.command` replaces that command so the
 * password from `secret_enc` (§11.2 "the backend credentials") reaches ssh through `sshpass -e`,
 * which reads it from `SSHPASS` rather than argv. Nothing in the target model carries a host key,
 * and ssh's default (ask) fails without a terminal, so the first contact's key is accepted and
 * pinned in `sshKnownHostsFile()`, under the host's name (`HostKeyAlias`) while ssh connects to
 * `address`, the one checked (§3.1 "Outbound targets"), so it resolves nothing itself. Every word
 * is quoted and `--` ends ssh's options before the address, so neither the host nor the username
 * can reach ssh as an option of its own.
 */
function sftpRepository(
  params: Params,
  secret: BackupSecret,
  address: string
): RepositoryAndEnv {
  const host = str(params, 'host');
  const user = credential(secret, 'username', 'sftp');
  const command = [
    'sshpass',
    '-e',
    'ssh',
    '-o',
    'StrictHostKeyChecking=accept-new',
    '-o',
    `UserKnownHostsFile=${sshKnownHostsFile()}`,
    '-o',
    `HostKeyAlias=${host}`,
    '-l',
    user,
    '-s',
    '--',
    address,
    'sftp'
  ]
    .map(sshWord)
    .join(' ');
  return {
    repository: `sftp:${user}@${host}:${str(params, 'path')}`,
    env: { SSHPASS: credential(secret, 'password', 'sftp') },
    options: ['-o', `sftp.command=${command}`]
  };
}

/** Every address `host` resolves to, rejecting with `forbiddenAddressError` when
 *  `ALLOW_PRIVATE_TARGETS` or the stack's own network refuses any (§3.1 "Outbound targets"). */
export type ResolveFn = (host: string) => Promise<string[]>;

export const resolveBackupHost: ResolveFn = host =>
  resolveTarget(host, { allowPrivate: privateEnv.ALLOW_PRIVATE_TARGETS });

/**
 * The restic repository string and backend env for `target.kind` (§6.5 "Target kinds"). A remote
 * target's server is resolved and checked first (`resolve`), so no tool runs against a refused
 * one; sftp and plain ftp then connect to the address checked, while s3, webdav and ftps resolve
 * the name again in restic or rclone, their TLS checking the certificate against it.
 */
export async function repositoryAndEnv(
  target: BackupTargetRow,
  secret: BackupSecret,
  exec: ExecFn,
  resolve: ResolveFn = resolveBackupHost
): Promise<RepositoryAndEnv> {
  const params = loadParams(target);
  const { kind } = target;
  if (kind === 'local') {
    // Checked on every write already; checked again for a row written before the rule.
    assertLocalPath(params.path);
    return { repository: str(params, 'path'), env: {}, options: [] };
  }
  const host = serverOf(kind, params);
  if (host === null) {
    throw new Error(`backup: a ${kind} target names no server`);
  }
  const [address = ''] = await resolve(host);
  switch (kind) {
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
      return sftpRepository(params, secret, address);
    case 'ftp':
    case 'ftps':
    case 'webdav':
      return rcloneRepository(kind, params, secret, exec, address);
    default:
      throw new Error(`backup: unknown target kind '${String(kind)}'`);
  }
}
