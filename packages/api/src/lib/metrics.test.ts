import { afterEach, describe, expect, it } from 'vitest';

import { newId, nowIso, type Db, type StateResponse } from '@zamfono/shared';

import {
  recordApiRequestSeconds,
  renderMetrics,
  resetMetricsAccumulators
} from './metrics.js';
import { makeTestDb } from './testDb.js';

const EMPTY_STATE: StateResponse = {
  calls: [],
  trunks: {},
  trunkChannels: {},
  registeredDevices: 0,
  recordingMixFailures: 0,
  presence: {}
};

function stubDeps(
  overrides: Partial<Parameters<typeof renderMetrics>[0]> & { db: Db }
): Parameters<typeof renderMetrics>[0] {
  return {
    dbFile: ':memory:',
    checkAri: () => Promise.resolve(true),
    coreState: () => Promise.resolve(EMPTY_STATE),
    certSyncStatus: () => 'unknown',
    version: { version: 'dev', revision: '', display: 'dev' },
    ...overrides
  };
}

/** Parses Prometheus text exposition into a map of the first sample's value per metric name. */
function parseMetrics(text: string): Map<string, string> {
  const values = new Map<string, string>();
  for (const line of text.split('\n')) {
    if (line === '' || line.startsWith('#')) {
      continue;
    }
    const spaceIndex = line.lastIndexOf(' ');
    const nameAndLabels = line.slice(0, spaceIndex);
    const name = nameAndLabels.split('{')[0] ?? nameAndLabels;
    if (!values.has(name)) {
      values.set(name, line.slice(spaceIndex + 1));
    }
  }
  return values;
}

async function insertTrunk(
  db: Db,
  overrides: {
    name?: string;
    priority?: number;
    maxChannels?: number | null;
  } = {}
): Promise<string> {
  const id = newId();
  await db
    .insertInto('trunks')
    .values({
      id,
      name: overrides.name ?? 'main',
      priority: overrides.priority ?? 1,
      emergency: 1,
      authMode: 'registration',
      username: 'trunkuser',
      passwordEnc: Buffer.from('placeholder'),
      inboundAuth: 0,
      transport: 'udp',
      outboundProxy: null,
      registerExpiryS: 3600,
      registerRetryS: 60,
      codecsJson: null,
      maxChannels: overrides.maxChannels ?? null,
      createdAt: nowIso()
    })
    .execute();
  return id;
}

describe('renderMetrics', () => {
  afterEach(() => {
    resetMetricsAccumulators();
  });

  it('renders parseable Prometheus text with the active-calls and ARI gauges', async () => {
    const db = await makeTestDb();
    const state: StateResponse = {
      calls: [
        {
          callId: 'c1',
          direction: 'inbound',
          from: '+1',
          to: '101',
          state: 'up',
          startedAt: nowIso(),
          ringGroupId: null,
          userIds: ['owner']
        }
      ],
      trunks: {},
      trunkChannels: {},
      registeredDevices: 0,
      recordingMixFailures: 0,
      presence: {}
    };

    const text = await renderMetrics(
      stubDeps({ db, coreState: () => Promise.resolve(state) })
    );

    const values = parseMetrics(text);
    expect(values.get('zamfono_active_calls')).toBe('1');
    expect(values.get('zamfono_ari_connected')).toBe('1');
    expect(text.endsWith('\n')).toBe(true);
  });

  it("reports the core's live registered-device count, not every device that ever registered", async () => {
    const db = await makeTestDb();
    // Once registered, now gone: `last_registered_at` stays set (§3.1).
    await db
      .insertInto('devices')
      .values({
        id: newId(),
        userId: 'owner',
        label: 'desk',
        kind: 'manual',
        sipUsername: 'e100-gone',
        sipPasswordEnc: Buffer.from('secret'),
        lastRegisteredAt: nowIso(),
        createdAt: nowIso()
      })
      .execute();

    const idle = await renderMetrics(stubDeps({ db }));
    const live = await renderMetrics(
      stubDeps({
        db,
        coreState: () =>
          Promise.resolve({ ...EMPTY_STATE, registeredDevices: 4 })
      })
    );

    expect(parseMetrics(idle).get('zamfono_registered_devices')).toBe('0');
    expect(parseMetrics(live).get('zamfono_registered_devices')).toBe('4');
  });

  it('reports zamfono_ari_connected 0 when the ARI check fails', async () => {
    const db = await makeTestDb();

    const text = await renderMetrics(
      stubDeps({ db, checkAri: () => Promise.reject(new Error('down')) })
    );

    expect(parseMetrics(text).get('zamfono_ari_connected')).toBe('0');
  });

  it('renders one zamfono_trunk_registered and zamfono_trunk_max_channels line per live trunk', async () => {
    const db = await makeTestDb();
    await insertTrunk(db, { maxChannels: 10 });
    const state: StateResponse = {
      calls: [],
      trunks: {},
      trunkChannels: {},
      registeredDevices: 0,
      recordingMixFailures: 0,
      presence: {}
    };

    const text = await renderMetrics(
      stubDeps({ db, coreState: () => Promise.resolve(state) })
    );

    expect(text).toContain('zamfono_trunk_registered{trunk="main"} 0');
    expect(text).toContain('zamfono_trunk_max_channels{trunk="main"} 10');
  });

  it('leaves an unmonitored trunk out of zamfono_trunk_registered (§9.4 "Provisioning and status")', async () => {
    const db = await makeTestDb();
    const upId = await insertTrunk(db, { name: 'up' });
    const unprobedId = await insertTrunk(db, { name: 'unprobed', priority: 2 });
    const state: StateResponse = {
      ...EMPTY_STATE,
      trunks: {
        [upId]: { status: 'registered', statusChangedAt: null },
        [unprobedId]: { status: 'unmonitored', statusChangedAt: null }
      }
    };

    const text = await renderMetrics(
      stubDeps({ db, coreState: () => Promise.resolve(state) })
    );

    expect(text).toContain('zamfono_trunk_registered{trunk="up"} 1');
    expect(text).not.toContain('zamfono_trunk_registered{trunk="unprobed"}');
    expect(text).toContain('zamfono_trunk_channels{trunk="unprobed"} 0');
  });

  it("renders each live trunk's channels in use from the core's count, 0 for one carrying none", async () => {
    const db = await makeTestDb();
    const busyId = await insertTrunk(db, { name: 'busy', maxChannels: 4 });
    await insertTrunk(db, { name: 'idle', priority: 2 });
    const state: StateResponse = {
      ...EMPTY_STATE,
      trunkChannels: { [busyId]: 3 }
    };

    const text = await renderMetrics(
      stubDeps({ db, coreState: () => Promise.resolve(state) })
    );

    expect(text).toContain('# TYPE zamfono_trunk_channels gauge');
    expect(text).toContain('zamfono_trunk_channels{trunk="busy"} 3');
    expect(text).toContain('zamfono_trunk_channels{trunk="idle"} 0');
  });

  it('escapes a newline in an operator-chosen trunk name instead of letting it forge a line', async () => {
    const db = await makeTestDb();
    await insertTrunk(db, { name: 'evil\nzamfono_ari_connected 0"trunk' });

    const text = await renderMetrics(stubDeps({ db }));

    expect(text).toContain(
      'zamfono_trunk_registered{trunk="evil\\nzamfono_ari_connected 0\\"trunk"} 0'
    );
    expect(text.split('\n')).not.toContain('zamfono_ari_connected 0');
  });

  it('renders zamfono_build_info with the version and the full revision (§7 "Version")', async () => {
    const db = await makeTestDb();

    const text = await renderMetrics(
      stubDeps({
        db,
        version: {
          version: '1.2.3',
          revision: 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0',
          display: '1.2.3 (a1b2c3d)'
        }
      })
    );

    expect(text).toContain('# TYPE zamfono_build_info gauge');
    expect(text).toContain(
      'zamfono_build_info{version="1.2.3",revision="a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0"} 1'
    );
  });

  it('renders the certificate-sync gauge from certSyncStatus', async () => {
    const db = await makeTestDb();

    const ok = await renderMetrics(
      stubDeps({ db, certSyncStatus: () => 'ok' })
    );
    const missing = await renderMetrics(
      stubDeps({ db, certSyncStatus: () => 'missing' })
    );

    expect(parseMetrics(ok).get('zamfono_certificate_sync_ok')).toBe('1');
    expect(parseMetrics(missing).get('zamfono_certificate_sync_ok')).toBe('0');
  });

  it('accumulates zamfono_api_request_seconds', async () => {
    const db = await makeTestDb();
    recordApiRequestSeconds(0.2);
    recordApiRequestSeconds(2);

    const text = await renderMetrics(stubDeps({ db }));

    expect(text).toContain('zamfono_api_request_seconds_count 2');
  });

  it("reports the core's recording-mix failures, and no sample while the core is unreachable", async () => {
    const db = await makeTestDb();

    const live = await renderMetrics(
      stubDeps({
        db,
        coreState: () =>
          Promise.resolve({ ...EMPTY_STATE, recordingMixFailures: 3 })
      })
    );
    const down = await renderMetrics(
      stubDeps({ db, coreState: () => Promise.reject(new Error('down')) })
    );

    expect(parseMetrics(live).get('zamfono_recording_mix_failures_total')).toBe(
      '3'
    );
    expect(down).toContain(
      '# TYPE zamfono_recording_mix_failures_total counter'
    );
    expect(parseMetrics(down).has('zamfono_recording_mix_failures_total')).toBe(
      false
    );
  });

  it("reports a backup target's last successful run age in seconds", async () => {
    const db = await makeTestDb();
    const targetId = newId();
    await db
      .insertInto('backupTargets')
      .values({
        id: targetId,
        kind: 'local',
        paramsJson: '{}',
        secretEnc: Buffer.from(''),
        createdAt: nowIso()
      })
      .execute();
    const finishedAt = new Date(Date.now() - 60_000).toISOString();
    await db
      .insertInto('backupRuns')
      .values({
        id: newId(),
        targetId,
        status: 'ok',
        startedAt: finishedAt,
        finishedAt
      })
      .execute();

    const text = await renderMetrics(stubDeps({ db, now: () => new Date() }));

    const line = text
      .split('\n')
      .find(entry =>
        entry.startsWith(
          `zamfono_backup_last_success_age_seconds{target="${targetId}"}`
        )
      );
    expect(line).toBeDefined();
    const age = Number((line ?? '').split(' ').at(-1));
    expect(age).toBeGreaterThanOrEqual(59);
    expect(age).toBeLessThan(65);
  });
});
