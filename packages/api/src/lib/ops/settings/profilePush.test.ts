import { afterEach, describe, expect, it } from 'vitest';

import {
  newId,
  nowIso,
  type CoreVersionResponse,
  type Db
} from '@zamfono/shared';

import { watchAsteriskRestarts } from '../../jobs/ringotelRereg.js';
import { isProfilePending } from '../../provisioning/profilePending.js';
import { encrypt, keyringFromEnv } from '../../secretbox.js';
import { makeTestDb } from '../../testDb.js';
import { onPropagate, runOperation, type RunInput } from '../runner.js';

import './index.js';

import { retryPendingProfile } from './profilePush.js';

process.env.SECRETBOX_KEY ??= `1:${Buffer.alloc(32, 7).toString('base64')}`;

const owner: RunInput = {
  actor: { id: 'owner', name: 'Owner', role: 'owner' },
  channel: 'rest',
  requestId: 'req-1'
};

/** The tenant row, set up with Ringotel, its main DID an external target. */
async function seedTenant(db: Db): Promise<void> {
  const targetId = newId();
  await db
    .insertInto('forwardTargets')
    .values({ id: targetId, external: '+490000000' })
    .execute();
  const mainDidId = newId();
  await db
    .insertInto('dids')
    .values({
      id: mainDidId,
      number: '+490000000',
      targetId,
      createdAt: nowIso()
    })
    .execute();
  await db
    .insertInto('settings')
    .values({
      id: 1,
      companyName: 'Test Co',
      country: 'DE',
      emergencyNumbersJson: '["112"]',
      mainDidId,
      ringotelOrgId: 'org-1',
      ringotelBranchId: 'branch-1',
      ringotelApiTokenEnc: encrypt(keyringFromEnv(process.env), 'ringotel-key')
    })
    .execute();
}

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
    owner
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
    await seedTenant(db);
    const ringotel = stubRingotel(false);
    // How many Ringotel calls had been made when the write propagated: none, since the push
    // waits for the commit and the propagation.
    const callsAtPropagation: number[] = [];
    onPropagate(change => {
      if (change.operation === 'settings.update') {
        callsAtPropagation.push(ringotel.methods.length);
      }
      return Promise.resolve();
    });

    const result = await runOperation<
      unknown,
      { emergencyNumbers: string[]; warnings?: string[] }
    >(db, 'settings.update', { emergencyNumbers: ['112', '110'] }, owner);

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

  it('records a push Ringotel takes and leaves nothing pending', async () => {
    const db = await makeTestDb();
    await seedTenant(db);
    const ringotel = stubRingotel(true);

    const result = await runOperation<unknown, { warnings?: string[] }>(
      db,
      'settings.update',
      { emergencyNumbers: ['112', '110'] },
      owner
    );

    expect(result.warnings).toBeUndefined();
    expect(ringotel.methods).toEqual(['updateBranch', 'updateOrganization']);
    expect(await isProfilePending(db)).toBe(false);
    expect(await profileRows(db)).toMatchObject([
      { outcome: 'pushed', trigger: 'settings.update' }
    ]);
  });

  it('retries once at api start and clears the marker when Ringotel takes it', async () => {
    const db = await makeTestDb();
    await seedTenant(db);
    await changeDuringOutage(db);
    const ringotel = stubRingotel(true);

    const watcher = watchAsteriskRestarts({
      db,
      lookup: core(nowIso()),
      retryProfile: trigger => retryPendingProfile(db, trigger)
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
    await seedTenant(db);
    await changeDuringOutage(db);
    const ringotel = stubRingotel(false);
    const watcher = watchAsteriskRestarts({
      db,
      lookup: core(nowIso()),
      retryProfile: trigger => retryPendingProfile(db, trigger)
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
    await seedTenant(db);
    const ringotel = stubRingotel(true);

    await retryPendingProfile(db, 'api.start');

    expect(ringotel.methods).toEqual([]);
    expect(await profileRows(db)).toEqual([]);
  });
});
