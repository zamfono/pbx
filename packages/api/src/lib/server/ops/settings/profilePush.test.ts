import * as privateEnv from '$app/env/private';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { nowIso, type CoreVersionResponse, type Db } from '@zamfono/shared';
import { seedSettings } from '@zamfono/shared/testDb.js';

import { watchAsteriskRestarts } from '#lib/server/jobs/ringotelRereg.js';
import { propagateConfig } from '#lib/server/propagation.js';
import { isProfilePending } from '#lib/server/provisioning/profilePending.js';
import { encrypt, keyringFromEnv } from '#lib/server/secretbox.js';
import { asRun, makeTestDb } from '#testing/testDb.js';

import { runOperation } from '../runner.js';

import './index.js';

import { retryPendingProfile } from './profilePush.js';

type Ringotel = { up: boolean; methods: string[] };

/** Stubs Ringotel's API: every call is recorded, and answered with HTTP 503 while it is down. */
function stubRingotel(up: boolean): Ringotel {
  const state: Ringotel = { up, methods: [] };
  globalThis.fetch = ((_url: string, init?: RequestInit) => {
    const body = JSON.parse(init?.body as string) as { method: string };
    state.methods.push(body.method);
    const result = body.method === 'getUsers' ? [] : {};
    return Promise.resolve(
      state.up
        ? new Response(JSON.stringify({ result }), {
            status: 200,
            headers: { 'content-type': 'application/json' }
          })
        : new Response(JSON.stringify({ error: 'Service Unavailable' }), {
            status: 503,
            headers: { 'content-type': 'application/json' }
          })
    );
  }) as typeof fetch;
  return state;
}

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

/** The `ringotel.profile` rows' changes, oldest first, as `{field: to}`. */
async function profileRows(db: Db): Promise<Record<string, unknown>[]> {
  const rows = await db
    .selectFrom('auditLog')
    .select(['changesJson', 'channel', 'undoable'])
    .where('operation', '=', 'ringotel.profile')
    .orderBy('createdAt')
    .execute();
  return rows.map(row => ({
    channel: row.channel,
    undoable: row.undoable,
    ...Object.fromEntries(
      (JSON.parse(row.changesJson) as { field: string; to: unknown }[]).map(
        change => [change.field, change.to]
      )
    )
  }));
}

/** An emergency-number change while Ringotel is down: stored, warned about, marked pending. */
async function changeDuringOutage(db: Db): Promise<unknown> {
  stubRingotel(false);
  return runOperation(
    db,
    'settings.update',
    { emergencyNumbers: ['112', '110'] },
    asRun()
  );
}

function core(asteriskStartedAt: string): () => Promise<CoreVersionResponse> {
  return () =>
    Promise.resolve({
      version: 'dev',
      revision: '',
      display: 'dev',
      startedAt: asteriskStartedAt,
      asteriskStartedAt
    });
}

describe('tenant profile push (§10.1 "Emergency calls", §10.4 "Tenant profile push")', () => {
  it('stores and propagates emergency numbers while Ringotel is down, warns, records the refusal and marks it pending', async () => {
    const db = await makeTestDb();
    await seedSettings(db, {
      ringotelOrgId: 'org-1',
      ringotelBranchId: 'branch-1',
      ringotelApiTokenEnc: encrypt(
        keyringFromEnv(privateEnv),
        'settings.ringotelApiTokenEnc',
        'ringotel-key'
      )
    });
    const ringotel = stubRingotel(false);
    // How many Ringotel calls had been made when the write propagated: none, since the push
    // waits for the commit and the propagation.
    const callsAtPropagation: number[] = [];
    vi.mocked(propagateConfig).mockImplementationOnce(() => {
      callsAtPropagation.push(ringotel.methods.length);
      return Promise.resolve();
    });

    const result = (await runOperation(
      db,
      'settings.update',
      { emergencyNumbers: ['112', '110'] },
      asRun()
    )) as { emergencyNumbers: string[]; warnings?: string[] };

    expect(result.emergencyNumbers).toEqual(['112', '110']);
    expect(
      JSON.parse(
        (
          await db
            .selectFrom('settings')
            .select('emergencyNumbersJson')
            .executeTakeFirstOrThrow()
        ).emergencyNumbersJson
      )
    ).toEqual(['112', '110']);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings?.[0]).toMatch(
      /Ringotel refused the tenant profile/u
    );
    expect(callsAtPropagation).toEqual([0]);
    expect(ringotel.methods).toEqual(['updateBranch']);
    expect(await isProfilePending(db)).toBe(true);
    expect(await profileRows(db)).toEqual([
      {
        channel: 'rest',
        undoable: 0,
        outcome: 'refused',
        trigger: 'settings.update',
        reason: "ringotel: 'updateBranch' failed: Service Unavailable"
      }
    ]);
  });

  it('records a Ringotel key it cannot use as a refusal and keeps the push pending', async () => {
    const db = await makeTestDb();
    await seedSettings(db, {
      ringotelOrgId: 'org-1',
      ringotelBranchId: 'branch-1',
      ringotelApiTokenEnc: null
    });
    const ringotel = stubRingotel(true);

    const result = (await runOperation(
      db,
      'settings.update',
      { emergencyNumbers: ['112', '110'] },
      asRun()
    )) as { warnings?: string[] };

    expect(result.warnings).toEqual([
      expect.stringMatching(/Ringotel refused the tenant profile/u)
    ]);
    expect(ringotel.methods).toEqual([]);
    expect(await isProfilePending(db)).toBe(true);
    expect(await profileRows(db)).toMatchObject([
      {
        outcome: 'refused',
        trigger: 'settings.update',
        reason: 'ringotel: no API token configured (settings.ringotelApiToken)'
      }
    ]);
  });

  it('records a push Ringotel takes and leaves nothing pending', async () => {
    const db = await makeTestDb();
    await seedSettings(db, {
      ringotelOrgId: 'org-1',
      ringotelBranchId: 'branch-1',
      ringotelApiTokenEnc: encrypt(
        keyringFromEnv(privateEnv),
        'settings.ringotelApiTokenEnc',
        'ringotel-key'
      )
    });
    const ringotel = stubRingotel(true);

    const result = (await runOperation(
      db,
      'settings.update',
      { emergencyNumbers: ['112', '110'] },
      asRun()
    )) as { warnings?: string[] };

    expect(result.warnings).toBeUndefined();
    expect(ringotel.methods).toEqual(['updateBranch', 'updateOrganization']);
    expect(await isProfilePending(db)).toBe(false);
    expect(await profileRows(db)).toMatchObject([
      { outcome: 'pushed', trigger: 'settings.update' }
    ]);
  });

  it('retries once at api start and clears the marker when Ringotel takes it', async () => {
    const db = await makeTestDb();
    await seedSettings(db, {
      ringotelOrgId: 'org-1',
      ringotelBranchId: 'branch-1',
      ringotelApiTokenEnc: encrypt(
        keyringFromEnv(privateEnv),
        'settings.ringotelApiTokenEnc',
        'ringotel-key'
      )
    });
    await changeDuringOutage(db);
    const ringotel = stubRingotel(true);

    const watcher = watchAsteriskRestarts({
      db,
      lookup: core(nowIso()),
      retryPending: trigger => retryPendingProfile(db, trigger)
    });
    await watcher.idle();

    expect(ringotel.methods).toEqual(['updateBranch', 'updateOrganization']);
    expect(await isProfilePending(db)).toBe(false);
    expect((await profileRows(db)).at(-1)).toMatchObject({
      channel: 'job',
      outcome: 'pushed',
      trigger: 'api.start'
    });
  });

  it('retries on asterisk.started ahead of the re-registration, once, and never loops on a refusal', async () => {
    const db = await makeTestDb();
    await seedSettings(db, {
      ringotelOrgId: 'org-1',
      ringotelBranchId: 'branch-1',
      ringotelApiTokenEnc: encrypt(
        keyringFromEnv(privateEnv),
        'settings.ringotelApiTokenEnc',
        'ringotel-key'
      )
    });
    await changeDuringOutage(db);
    const ringotel = stubRingotel(false);
    const watcher = watchAsteriskRestarts({
      db,
      lookup: core(nowIso()),
      retryPending: trigger => retryPendingProfile(db, trigger)
    });
    await watcher.idle();
    // The start retry was refused: one push, the marker kept, no further attempt of its own.
    expect(ringotel.methods).toEqual(['updateBranch']);
    expect(await isProfilePending(db)).toBe(true);
    await new Promise(resolve => {
      setTimeout(resolve, 50);
    });
    expect(ringotel.methods).toEqual(['updateBranch']);

    ringotel.up = true;
    watcher.asteriskStarted(new Date(Date.now() + 60_000).toISOString());
    await watcher.idle();

    // The profile push (branch and organization) first, then the re-registration's branch push.
    expect(ringotel.methods).toEqual([
      'updateBranch',
      'updateBranch',
      'updateOrganization',
      'updateBranch'
    ]);
    expect(await isProfilePending(db)).toBe(false);
    expect((await profileRows(db)).map(row => row.trigger)).toEqual([
      'settings.update',
      'api.start',
      'asterisk.started'
    ]);
  });

  it('sends nothing on a retry while nothing is pending', async () => {
    const db = await makeTestDb();
    await seedSettings(db, {
      ringotelOrgId: 'org-1',
      ringotelBranchId: 'branch-1',
      ringotelApiTokenEnc: encrypt(
        keyringFromEnv(privateEnv),
        'settings.ringotelApiTokenEnc',
        'ringotel-key'
      )
    });
    const ringotel = stubRingotel(true);

    await retryPendingProfile(db, 'api.start');

    expect(ringotel.methods).toEqual([]);
    expect(await profileRows(db)).toEqual([]);
  });
});
