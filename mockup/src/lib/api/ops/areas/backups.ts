/**
 * Backups (`ops/backups/`, §6.5): restic targets and their runs. A target's `params` hold the
 * repository location per kind and the forget policy (default 7 daily, 4 weekly, 6 monthly); its
 * secret is the restic password plus the kind's backend credentials, write-only. A manual run
 * (`backups.runs.start`) is a pure action: it shows `running` at once and finishes a few seconds
 * later with `backup.started` / `backup.finished`, as the scheduler would report it.
 */
import { nowDate as demoNowDate } from '#lib/clock.svelte.js';
import { onDemoReset } from '#lib/state/demo.js';

import { invalid, notFound } from '../../errors';
import { emit } from '../../events.svelte';
import { newId } from '../../ids';
import { store, touch } from '../../store.svelte';
import {
  BACKUP_TARGET_KINDS,
  type BackupForget,
  type BackupRun,
  type BackupTarget,
  type BackupTargetKind,
  type ChangeEntry
} from '../../types';
import { defineOp } from '../core';

export type BackupTargetWire = Omit<BackupTarget, 'deletedAt' | 'label'>;
export type BackupRunWire = Omit<BackupRun, 'trigger'>;
export type BackupParams = Record<string, string | BackupForget>;

export type BackupSecret = {
  resticPassword: string;
  username?: string;
  password?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
};

export const DEFAULT_FORGET: BackupForget = {
  keepDaily: 7,
  keepWeekly: 4,
  keepMonthly: 6
};

const CREDENTIALS = [
  'username',
  'password',
  'accessKeyId',
  'secretAccessKey'
] as const;

/** The backend credentials each kind takes beside the restic password (`_secret.ts`). */
export const CREDENTIALS_BY_KIND: Record<
  BackupTargetKind,
  readonly (typeof CREDENTIALS)[number][]
> = {
  local: [],
  s3: ['accessKeyId', 'secretAccessKey'],
  sftp: ['username', 'password'],
  ftp: ['username', 'password'],
  ftps: ['username', 'password'],
  webdav: ['username', 'password']
};

/** The location fields per kind (`targetFields.params`); `required` are the ones the API checks. */
export const PARAMS_BY_KIND: Record<
  BackupTargetKind,
  { key: string; required: boolean }[]
> = {
  local: [{ key: 'path', required: false }],
  s3: [
    { key: 'endpoint', required: false },
    { key: 'bucket', required: false },
    { key: 'path', required: false }
  ],
  sftp: [
    { key: 'host', required: true },
    { key: 'path', required: false }
  ],
  ftp: [
    { key: 'host', required: true },
    { key: 'path', required: false }
  ],
  ftps: [
    { key: 'host', required: true },
    { key: 'path', required: false }
  ],
  webdav: [
    { key: 'url', required: true },
    { key: 'path', required: false }
  ]
};

const MASK = '•••';
const FQDN =
  /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/iu;
const IPV4 = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/u;
const UNSAFE_SFTP_USERNAME = /^-|[\s"'\\]/u;
const RUN_MS = 4500;

const targetToWire = ({
  deletedAt: _deleted,
  label: _label,
  ...wire
}: BackupTarget): BackupTargetWire => wire;
const runToWire = ({ trigger: _trigger, ...wire }: BackupRun): BackupRunWire =>
  wire;

function checkKind(kind: unknown): BackupTargetKind {
  if (!BACKUP_TARGET_KINDS.includes(kind as BackupTargetKind)) {
    throw invalid('kind', 'invalid', 'unknown target kind', {
      message: String(kind)
    });
  }
  return kind as BackupTargetKind;
}

/** `params` with the forget policy defaulted, as `withDefaultForgetPolicy` stores it. */
function withDefaultForget(params: BackupParams): BackupParams {
  return 'forget' in params
    ? params
    : { ...params, forget: { ...DEFAULT_FORGET } };
}

/** An sftp/ftp/ftps host is an FQDN or IPv4 address; a webdav url is http(s) (`assertParamsFitKind`). */
function checkParams(kind: BackupTargetKind, params: BackupParams): void {
  if (kind === 'sftp' || kind === 'ftp' || kind === 'ftps') {
    const host = typeof params.host === 'string' ? params.host : '';
    if (!FQDN.test(host) && !IPV4.test(host)) {
      throw invalid(
        'params.host',
        'backupHost',
        'host must be an FQDN or an IPv4 address'
      );
    }
  }
  if (kind === 'webdav') {
    let ok = false;
    try {
      const url = new URL(typeof params.url === 'string' ? params.url : '');
      ok = url.protocol === 'http:' || url.protocol === 'https:';
    } catch {
      ok = false;
    }
    if (!ok) {
      throw invalid(
        'params.url',
        'backupWebdavUrl',
        'a webdav target needs an http or https url'
      );
    }
  }
  const forget = params.forget;
  if (forget !== undefined && typeof forget === 'object') {
    for (const key of ['keepDaily', 'keepWeekly', 'keepMonthly'] as const) {
      if (!Number.isInteger(forget[key]) || forget[key] < 0) {
        throw invalid(
          `params.forget.${key}`,
          'range',
          'a whole number of snapshots',
          { min: 0, max: 9999 }
        );
      }
    }
  }
}

/** The secret carries exactly the kind's credentials (`assertSecretFitsKind`). */
function checkSecret(kind: BackupTargetKind, secret: BackupSecret): void {
  if (
    typeof secret.resticPassword !== 'string' ||
    secret.resticPassword === ''
  ) {
    throw invalid(
      'secret.resticPassword',
      'required',
      'resticPassword is required'
    );
  }
  const wanted = CREDENTIALS_BY_KIND[kind];
  for (const field of CREDENTIALS) {
    const present = typeof secret[field] === 'string' && secret[field] !== '';
    if (wanted.includes(field) !== present) {
      throw invalid(
        `secret.${wanted.includes(field) ? field : 'resticPassword'}`,
        'backupSecretKind',
        'the secret does not fit the kind',
        {
          fields: ['resticPassword', ...wanted].join(', ')
        }
      );
    }
  }
  if (kind === 'sftp' && UNSAFE_SFTP_USERNAME.test(secret.username ?? '')) {
    throw invalid(
      'secret.username',
      'backupSftpUsername',
      'unsafe sftp username'
    );
  }
}

function liveTarget(targets: BackupTarget[], id: string): BackupTarget {
  const row = targets.find(
    candidate => candidate.id === id && candidate.deletedAt === null
  );
  if (row === undefined) {
    throw notFound('backupTarget', id);
  }
  return row;
}

/** A display name for a target, which the API names by kind and location alone. */
export function targetLocation(target: {
  kind: BackupTargetKind;
  params: BackupParams;
}): string {
  const text = (key: string): string => {
    const value = target.params[key];
    return typeof value === 'string' ? value : '';
  };
  switch (target.kind) {
    case 'local':
      return text('path') || '/backups/restic';
    case 's3':
      return [text('endpoint'), text('bucket')].filter(Boolean).join(' / ');
    case 'webdav':
      return text('url');
    default:
      return text('host');
  }
}

/* ---------------- targets ---------------- */

defineOp<
  { limit?: number; cursor?: string },
  { items: BackupTargetWire[]; nextCursor: null }
>({
  name: 'backups.targets.list',
  minRole: 'admin',
  readOnly: true,
  run: ctx => ({
    items: ctx.db.backupTargets
      .filter(row => row.deletedAt === null)
      .map(targetToWire),
    nextCursor: null
  })
});

defineOp<
  {
    kind: BackupTargetKind;
    params: BackupParams;
    secret: BackupSecret;
    enabled?: boolean;
  },
  BackupTargetWire
>({
  name: 'backups.targets.create',
  minRole: 'admin',
  run: (ctx, input) => {
    const kind = checkKind(input.kind);
    const params = withDefaultForget(input.params);
    checkParams(kind, params);
    checkSecret(kind, input.secret);
    const row: BackupTarget = {
      id: newId(),
      kind,
      label: '',
      params,
      secretSet: true,
      enabled: input.enabled ?? true,
      createdAt: ctx.now,
      deletedAt: null
    };
    ctx.insert('backupTargets', row);
    ctx.audit({
      entityKind: 'backupTarget',
      entityId: row.id,
      changes: [
        { field: 'kind', from: null, to: kind },
        { field: 'secret', from: MASK, to: MASK }
      ],
      undoable: false
    });
    return targetToWire(row);
  }
});

defineOp<
  {
    id: string;
    kind?: BackupTargetKind;
    params?: BackupParams;
    secret?: BackupSecret;
    enabled?: boolean;
  },
  BackupTargetWire
>({
  name: 'backups.targets.update',
  minRole: 'admin',
  run: (ctx, input) => {
    const before = liveTarget(ctx.db.backupTargets, input.id);
    const kind = input.kind === undefined ? before.kind : checkKind(input.kind);
    const params =
      input.params === undefined
        ? before.params
        : withDefaultForget(input.params);
    if (input.params !== undefined || kind !== before.kind) {
      checkParams(kind, params);
    }
    if (input.secret !== undefined) {
      checkSecret(kind, input.secret);
    } else if (
      kind !== before.kind &&
      CREDENTIALS_BY_KIND[kind].join() !==
        CREDENTIALS_BY_KIND[before.kind].join()
    ) {
      throw invalid(
        'secret.resticPassword',
        'backupSecretKind',
        'a new kind needs its credentials',
        {
          fields: ['resticPassword', ...CREDENTIALS_BY_KIND[kind]].join(', ')
        }
      );
    }
    const after: BackupTarget = {
      ...before,
      kind,
      params,
      enabled: input.enabled ?? before.enabled
    };
    const changes: ChangeEntry[] = (['kind', 'enabled', 'params'] as const)
      .filter(
        field => JSON.stringify(before[field]) !== JSON.stringify(after[field])
      )
      .map(field => ({ field, from: before[field], to: after[field] }));
    if (input.secret !== undefined) {
      changes.push({ field: 'secret', from: MASK, to: MASK });
    }
    if (changes.length === 0) {
      return targetToWire(before);
    }
    ctx.put('backupTargets', after);
    ctx.audit({
      entityKind: 'backupTarget',
      entityId: after.id,
      changes,
      undoable: input.secret === undefined
    });
    return targetToWire(after);
  }
});

defineOp<{ id: string }, { id: string }>({
  name: 'backups.targets.delete',
  minRole: 'admin',
  confirm: (ctx, input) => {
    const target = liveTarget(ctx.db.backupTargets, input.id);
    return {
      key: 'backups.targets.delete',
      params: {
        kind: target.kind.toUpperCase(),
        location: targetLocation(target)
      },
      destructive: true
    };
  },
  run: (ctx, input) => {
    const before = { ...liveTarget(ctx.db.backupTargets, input.id) };
    ctx.softDelete('backupTargets', before.id);
    ctx.audit({
      entityKind: 'backupTarget',
      entityId: before.id,
      before,
      after: { ...before, deletedAt: ctx.now }
    });
    return { id: before.id };
  }
});

/* ---------------- runs ---------------- */

defineOp<
  { targetId?: string; limit?: number; cursor?: string },
  { items: BackupRunWire[]; nextCursor: null }
>({
  name: 'backups.runs.list',
  minRole: 'admin',
  readOnly: true,
  run: (ctx, input) => ({
    items: ctx.db.backupRuns
      .filter(
        row => input.targetId === undefined || row.targetId === input.targetId
      )
      .toSorted((a, b) => b.startedAt.localeCompare(a.startedAt))
      .map(runToWire),
    nextCursor: null
  })
});

defineOp<{ id: string }, BackupRunWire>({
  name: 'backups.runs.get',
  minRole: 'admin',
  readOnly: true,
  run: (ctx, input) => {
    const row = ctx.db.backupRuns.find(candidate => candidate.id === input.id);
    if (row === undefined) {
      throw notFound('backupRun', input.id);
    }
    return runToWire(row);
  }
});

const timers = new Set<ReturnType<typeof setTimeout>>();
onDemoReset(() => {
  for (const timer of timers) {
    clearTimeout(timer);
  }
  timers.clear();
});

/** Finishes run `runId` as restic would: a snapshot, the bytes it added and the repository total. */
function finishRun(runId: string): void {
  const db = store.db;
  const run = db.backupRuns.find(candidate => candidate.id === runId);
  if (run === undefined || run.status !== 'running') {
    return;
  }
  const previous = db.backupRuns
    .filter(
      candidate =>
        candidate.targetId === run.targetId &&
        candidate.status === 'ok' &&
        candidate.bytesTotal !== null
    )
    .toSorted((a, b) => b.startedAt.localeCompare(a.startedAt))[0];
  const bytesAdded = Math.round((0.4 + Math.random() * 1.6) * 1_048_576);
  const bytesTotal = (previous?.bytesTotal ?? 400 * 1_048_576) + bytesAdded;
  const finishedAt = demoNowDate().toISOString();
  const snapshotId = newId().replace(/-/gu, '').slice(-8);
  Object.assign(run, {
    status: 'ok',
    finishedAt,
    bytesAdded,
    bytesTotal,
    snapshotId,
    error: null
  });
  emit({
    type: 'backup.finished',
    targetId: run.targetId,
    runId,
    snapshotId,
    bytesAdded,
    bytesTotal,
    durationS: Math.round(
      (new Date(finishedAt).getTime() - new Date(run.startedAt).getTime()) /
        1000
    )
  });
  touch();
}

defineOp<{ targetId: string }, BackupRunWire>({
  name: 'backups.runs.start',
  minRole: 'admin',
  run: (ctx, input) => {
    const target = liveTarget(ctx.db.backupTargets, input.targetId);
    const row: BackupRun = {
      id: newId(),
      targetId: target.id,
      status: 'running',
      trigger: 'manual',
      startedAt: ctx.now,
      finishedAt: null,
      bytesAdded: null,
      bytesTotal: null,
      snapshotId: null,
      error: null
    };
    ctx.db.backupRuns.push(row);
    ctx.audit({
      entityKind: 'backupRun',
      entityId: row.id,
      changes: [],
      pure: true
    });
    ctx.emit({ type: 'backup.started', targetId: target.id, runId: row.id });
    const timer = setTimeout(() => {
      timers.delete(timer);
      finishRun(row.id);
    }, RUN_MS);
    timers.add(timer);
    return runToWire(row);
  }
});

/** A run still `running` when the app starts belongs to a page load that ended: like `api` after a
 * restart, mark it failed with error `interrupted` (§6.5). */
function failInterruptedRuns(): void {
  let changed = false;
  for (const run of store.db.backupRuns) {
    if (run.status === 'running') {
      Object.assign(run, {
        status: 'failed',
        finishedAt: demoNowDate().toISOString(),
        error: 'interrupted'
      });
      changed = true;
    }
  }
  if (changed) {
    touch();
  }
}
failInterruptedRuns();
