/**
 * `GET /metrics` (§7 "Metrics"): Prometheus text exposition of active calls, registered
 * devices, trunk registration and capacity, ARI connection state, API request latency,
 * database size, backup freshness, recording-mix failures, certificate-sync status and what is
 * known of updates.
 */
import { stat } from 'node:fs/promises';

import {
  MS_PER_SECOND,
  type Db,
  type StateResponse,
  type ZamfonoVersion
} from '@zamfono/shared';

import type { CertSyncStatus } from './jobs/certSync.js';
import { updateNews } from './ops/system/_state.js';

/* eslint-disable no-magic-numbers -- Prometheus's suggested latency-histogram bucket bounds, meaningful only as this literal list */
const API_REQUEST_SECONDS_BUCKETS = [
  0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10
] as const;
/* eslint-enable no-magic-numbers */

export type MetricsDeps = {
  db: Db;
  dbFile: string;
  checkAri: () => Promise<boolean>;
  coreState: () => Promise<StateResponse>;
  certSyncStatus: () => CertSyncStatus;
  version: ZamfonoVersion;
  now?: () => Date;
};

/** Escapes `\`, newlines and `"` in a Prometheus label value (operator-supplied names, e.g. a trunk's), in that order so an escape this introduces is never itself re-escaped. */
function escapeLabel(value: string): string {
  return value
    .replace(/\\/gu, '\\\\')
    .replace(/\n/gu, '\\n')
    .replace(/\r/gu, '\\r')
    .replace(/"/gu, '\\"');
}

function gaugeLines(name: string, value: number): string[] {
  return [`# TYPE ${name} gauge`, `${name} ${value}`];
}

// Module-level accumulator (§7 "API latency"): the request pipeline reports into it from
// wherever it runs; this module only holds and renders the counts.
const apiRequestSeconds = {
  bucketCounts: API_REQUEST_SECONDS_BUCKETS.map(() => 0),
  sum: 0,
  count: 0
};

/** Records one completed API request's duration for the `zamfono_api_request_seconds` histogram. */
export function recordApiRequestSeconds(seconds: number): void {
  apiRequestSeconds.sum += seconds;
  apiRequestSeconds.count += 1;
  API_REQUEST_SECONDS_BUCKETS.forEach((bound, index) => {
    if (seconds <= bound) {
      const count = apiRequestSeconds.bucketCounts[index];
      // `bucketCounts` is built from this same bucket list, so every index here is in range.
      if (count === undefined) {
        throw new Error(`metrics: bucket index out of range: ${index}`);
      }
      apiRequestSeconds.bucketCounts[index] = count + 1;
    }
  });
}

/** Test-only: clears the accumulator between cases. */
export function resetMetricsAccumulators(): void {
  apiRequestSeconds.bucketCounts.fill(0);
  apiRequestSeconds.sum = 0;
  apiRequestSeconds.count = 0;
}

/** §10.2 "Best effort": the mixes `core`'s recorder failed since it started. Without a reading
 * from `core` the sample is left out rather than reported as 0, which a scraper would take for
 * a counter reset. */
function recordingMixFailureLines(state: StateResponse | null): string[] {
  const lines = ['# TYPE zamfono_recording_mix_failures_total counter'];
  if (state !== null) {
    lines.push(
      `zamfono_recording_mix_failures_total ${state.recordingMixFailures}`
    );
  }
  return lines;
}

function apiRequestHistogramLines(): string[] {
  const lines = ['# TYPE zamfono_api_request_seconds histogram'];
  API_REQUEST_SECONDS_BUCKETS.forEach((bound, index) => {
    lines.push(
      `zamfono_api_request_seconds_bucket{le="${bound}"} ${apiRequestSeconds.bucketCounts[index]}`
    );
  });
  lines.push(
    `zamfono_api_request_seconds_bucket{le="+Inf"} ${apiRequestSeconds.count}`,
    `zamfono_api_request_seconds_sum ${apiRequestSeconds.sum}`,
    `zamfono_api_request_seconds_count ${apiRequestSeconds.count}`
  );
  return lines;
}

async function trunkMetricLines(
  db: Db,
  state: StateResponse | null
): Promise<string[]> {
  const trunks = await db
    .selectFrom('trunks')
    .select(['id', 'name', 'maxChannels'])
    .where('deletedAt', 'is', null)
    .execute();
  const lines = ['# TYPE zamfono_trunk_registered gauge'];
  for (const trunk of trunks) {
    const status = state?.trunks[trunk.id]?.status;
    // An `unmonitored` trunk is never probed, so there is nothing to report for it: a 0 would read
    // as a trunk that is down (§9.4 "Provisioning and status").
    if (status === 'unmonitored') {
      continue;
    }
    const registered = status === 'registered';
    lines.push(
      `zamfono_trunk_registered{trunk="${escapeLabel(trunk.name)}"} ${registered ? 1 : 0}`
    );
  }
  // §7 "channels in use per trunk against `max_channels`": the core's count of active legs (§9.4
  // "Channels"), which leaves out a trunk carrying none.
  lines.push('# TYPE zamfono_trunk_channels gauge');
  for (const trunk of trunks) {
    const channels = state?.trunkChannels[trunk.id] ?? 0;
    lines.push(
      `zamfono_trunk_channels{trunk="${escapeLabel(trunk.name)}"} ${channels}`
    );
  }
  lines.push('# TYPE zamfono_trunk_max_channels gauge');
  for (const trunk of trunks) {
    if (trunk.maxChannels !== null) {
      lines.push(
        `zamfono_trunk_max_channels{trunk="${escapeLabel(trunk.name)}"} ${trunk.maxChannels}`
      );
    }
  }
  return lines;
}

/** `zamfono_build_info` (§7 "Version"): the full revision in the label, unlike the short one in a log line or `serverInfo.version`, since a scraper can filter on it exactly. */
function buildInfoLines(version: ZamfonoVersion): string[] {
  return [
    '# TYPE zamfono_build_info gauge',
    `zamfono_build_info{version="${escapeLabel(version.version)}",revision="${escapeLabel(version.revision)}"} 1`
  ];
}

async function dbSizeBytes(dbFile: string): Promise<number> {
  if (dbFile === ':memory:') {
    return 0;
  }
  try {
    return (await stat(dbFile)).size;
  } catch {
    return 0;
  }
}

/** The age, in seconds, of each enabled backup target's latest successful run (§6.5, §7). */
async function backupAgeLines(db: Db, now: () => Date): Promise<string[]> {
  const targets = await db
    .selectFrom('backupTargets')
    .select('id')
    .where('deletedAt', 'is', null)
    .execute();
  const lines = ['# TYPE zamfono_backup_last_success_age_seconds gauge'];
  for (const target of targets) {
    // eslint-disable-next-line no-await-in-loop -- a handful of backup targets, queried in order
    const lastOk = await db
      .selectFrom('backupRuns')
      .select('finishedAt')
      .where('targetId', '=', target.id)
      .where('status', '=', 'ok')
      .orderBy('finishedAt', 'desc')
      .executeTakeFirst();
    if (lastOk?.finishedAt) {
      const ageSeconds =
        (now().getTime() - Date.parse(lastOk.finishedAt)) / MS_PER_SECOND;
      lines.push(
        `zamfono_backup_last_success_age_seconds{target="${escapeLabel(target.id)}"} ${ageSeconds}`
      );
    }
  }
  return lines;
}

/**
 * §6.3 "Automatic updates": whether an automatic update failed and the failed attempts on its
 * release, and whether a breaking release waits for `update.sh`; all 0 without an updater.
 */
async function updateLines(db: Db): Promise<string[]> {
  const news = await updateNews(db);
  return [
    ...gaugeLines('zamfono_auto_update_failed', news.autoUpdateFailed ? 1 : 0),
    ...gaugeLines(
      'zamfono_auto_update_failed_attempts',
      news.autoUpdateFailedAttempts
    ),
    ...gaugeLines(
      'zamfono_breaking_update_available',
      news.breakingUpdateAvailable ? 1 : 0
    )
  ];
}

/** Renders the full `GET /metrics` body (§7 "Metrics"). */
export async function renderMetrics(deps: MetricsDeps): Promise<string> {
  const now = deps.now ?? (() => new Date());
  const [state, ariConnected] = await Promise.all([
    deps.coreState().catch(() => null),
    deps.checkAri().catch(() => false)
  ]);
  const lines = [
    ...gaugeLines('zamfono_active_calls', state?.calls.length ?? 0),
    // The core's live registrations: `devices.last_registered_at` records only that a device once
    // registered (§3.1), so it cannot say how many are registered now.
    ...gaugeLines('zamfono_registered_devices', state?.registeredDevices ?? 0),
    ...(await trunkMetricLines(deps.db, state)),
    ...gaugeLines('zamfono_ari_connected', ariConnected ? 1 : 0),
    ...apiRequestHistogramLines(),
    ...gaugeLines('zamfono_db_bytes', await dbSizeBytes(deps.dbFile)),
    ...(await backupAgeLines(deps.db, now)),
    ...gaugeLines(
      'zamfono_certificate_sync_ok',
      deps.certSyncStatus() === 'ok' ? 1 : 0
    ),
    ...recordingMixFailureLines(state),
    ...(await updateLines(deps.db)),
    ...buildInfoLines(deps.version)
  ];
  return `${lines.join('\n')}\n`;
}
