/**
 * System state and updates (`ops/system/`, §6.3 "Updates", §7 "Version"): `system.info` for anyone
 * signed in, `system.checkUpdate` for admins, `system.update` for owners. An update needs a backup
 * run finished `ok` within the last hour; it then runs as maintenance (calls drop while the stack
 * restarts) and ends on the new release a few seconds later.
 */
import { nowDate as demoNowDate } from '#lib/clock.svelte.js';
import { onDemoReset } from '#lib/state/demo.js';

import { ApiError, conflict, invalid } from '../../errors';
import { store, touch } from '../../store.svelte';
import type { SystemInfo } from '../../types';
import { defineOp } from '../core';
import { relayConfigured } from './settings';

export type UpdateState = SystemInfo['update']['last'];

const BACKUP_MAX_AGE_MS = 3_600_000;
const UPDATE_MS = 6000;

export const VERSION_PATTERN = /^\d+\.\d+\.\d+$/u;

/** The time of the newest backup run that finished `ok`, or null. */
export function lastGoodBackupAt(db: typeof store.db): string | null {
  return (
    db.backupRuns
      .filter(run => run.status === 'ok' && run.finishedAt !== null)
      .map(run => run.finishedAt as string)
      .sort()
      .at(-1) ?? null
  );
}

/** Whether a backup finished `ok` within the hour before `now` (`_request.ts`). */
export function hasRecentBackup(db: typeof store.db, now: string): boolean {
  const last = lastGoodBackupAt(db);
  return (
    last !== null &&
    new Date(now).getTime() - new Date(last).getTime() <= BACKUP_MAX_AGE_MS
  );
}

let updateTimer: ReturnType<typeof setTimeout> | undefined;
onDemoReset(() => clearTimeout(updateTimer));

function revision(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(4)), byte =>
    byte.toString(16).padStart(2, '0')
  ).join('');
}

/** The updater's run ends: both processes on the new release, the stack out of maintenance. */
function finishUpdate(): void {
  const system = store.db.system;
  const target = system.update.last.to;
  if (!system.maintenance || target === undefined) {
    return;
  }
  const now = demoNowDate().toISOString();
  const rev = revision();
  const version = {
    version: target,
    revision: rev,
    display: `${target} (${rev.slice(0, 7)})`
  };
  system.api = { ...version, startedAt: now };
  system.core = { ...version, startedAt: now, asteriskStartedAt: now };
  system.update = {
    ...system.update,
    current: target,
    updatable: false,
    last: { ...system.update.last, state: 'succeeded', finishedAt: now }
  };
  system.maintenance = false;
  touch();
}

defineOp<Record<string, never>, SystemInfo>({
  name: 'system.info',
  minRole: 'user',
  scope: 'any',
  readOnly: true,
  run: ctx => {
    const system = ctx.db.system;
    return {
      ...system,
      autoUpdate: { ...system.autoUpdate, enabled: ctx.db.settings.autoUpdate },
      mail: relayConfigured(ctx.db.settings) ? system.mail : null
    };
  }
});

defineOp<Record<string, never>, SystemInfo['update']>({
  name: 'system.checkUpdate',
  minRole: 'admin',
  readOnly: true,
  run: ctx => ({ ...ctx.db.system.update })
});

defineOp<{ version?: string }, UpdateState>({
  name: 'system.update',
  minRole: 'owner',
  confirm: (ctx, input) => ({
    key: 'system.update',
    params: {
      version: input.version ?? ctx.db.system.update.latest?.version ?? ''
    },
    irreversible: true
  }),
  run: (ctx, input) => {
    const system = ctx.db.system;
    const latest = system.update.latest;
    if (input.version !== undefined && !VERSION_PATTERN.test(input.version)) {
      throw invalid(
        'version',
        'updateVersionFormat',
        'version must look like 0.2.0'
      );
    }
    if (system.maintenance || system.update.last.state === 'running') {
      throw conflict(
        'updateRunning',
        'system.update: an update is already running'
      );
    }
    if (latest === null || !system.update.updatable) {
      throw conflict(
        'updateNothingNewer',
        'system.update: no newer non-breaking release'
      );
    }
    if (input.version !== undefined && input.version !== latest.version) {
      throw new ApiError(
        404,
        'updateVersionUnknown',
        `system.update: no published release ${input.version}`,
        {
          params: { version: input.version }
        }
      );
    }
    if (!hasRecentBackup(ctx.db, ctx.now)) {
      throw conflict(
        'updateNeedsBackup',
        'system.update: no backup finished ok within the last hour; start one with backups.runs.start, wait until backups.runs.get reports ok, then update'
      );
    }
    const state: UpdateState = {
      state: 'running',
      from: system.update.current ?? undefined,
      to: latest.version,
      startedAt: ctx.now,
      trigger: 'manual',
      by: ctx.actor.name
    };
    system.update = { ...system.update, last: state };
    system.maintenance = true;
    ctx.audit({
      entityKind: 'system',
      entityId: null,
      changes: [],
      pure: true
    });
    clearTimeout(updateTimer);
    updateTimer = setTimeout(finishUpdate, UPDATE_MS);
    return state;
  }
});

/** An update that was running when the page closed has finished meanwhile. */
if (store.db.system.maintenance) {
  finishUpdate();
}
