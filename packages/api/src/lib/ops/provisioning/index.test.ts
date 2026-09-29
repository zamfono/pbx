import { sql } from 'kysely';
import { afterEach, describe, expect, it } from 'vitest';

import { newId, nowIso, type Db } from '@zamfono/shared';

import {
  FAKE_PACKAGES,
  FAKE_REGIONS,
  installRingotelFake
} from '../../provisioning/ringotelFake.js';
import { encrypt, keyringFromEnv } from '../../secretbox.js';
import { makeTestDb } from '../../testDb.js';
import { runOperation, type RunInput } from '../runner.js';
import { type Actor } from '../types.js';

import './index.js';

process.env.SECRETBOX_KEY ??= `1:${Buffer.alloc(32, 7).toString('base64')}`;
process.env.ORIGIN = 'https://pbx.example.com';

const owner: Actor = { id: 'owner', name: 'Owner', role: 'owner' };

function asRun(overrides: Partial<RunInput> = {}): RunInput {
  return { actor: owner, channel: 'rest', requestId: 'req-1', ...overrides };
}

/** Seeds `settings` with a Ringotel API token and no organization/connection yet. */
async function seedSettings(db: Db): Promise<void> {
  const targetId = newId();
  await db
    .insertInto('forwardTargets')
    .values({ id: targetId, external: '+490000000' })
    .execute();
  const didId = newId();
  await db
    .insertInto('dids')
    .values({ id: didId, number: '+490000000', targetId, createdAt: nowIso() })
    .execute();
  await db
    .insertInto('settings')
    .values({
      id: 1,
      companyName: 'Test Co',
      country: 'DE',
      language: 'de',
      emergencyNumbersJson: '["112"]',
      mainDidId: didId,
      ringotelApiTokenEnc: encrypt(keyringFromEnv(process.env), 'ringotel-key')
    })
    .execute();
  await db
    .insertInto('extensions')
    .values({ ext: '701', isParkingSlot: 1 })
    .execute();
}

type FetchCall = { method: string; params: Record<string, unknown> };

/** Stubs `globalThis.fetch` to record every Ringotel RPC call and answer from `results`; the
 *  region and package lists setup checks its input against answer as the fake's do. */
function stubFetch(stubbed: Record<string, unknown>): FetchCall[] {
  const results: Record<string, unknown> = {
    getRegions: FAKE_REGIONS,
    getPackages: FAKE_PACKAGES,
    ...stubbed
  };
  const calls: FetchCall[] = [];
  globalThis.fetch = ((_url: string, init?: RequestInit) => {
    const body = JSON.parse(init?.body as string) as FetchCall;
    calls.push(body);
    return Promise.resolve(
      new Response(JSON.stringify({ result: results[body.method] }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
    );
  }) as typeof fetch;
  return calls;
}

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe('provisioning.ringotelSetup', () => {
  it('creates the organization then the connection, and stores both ids', async () => {
    const db = await makeTestDb();
    await seedSettings(db);
    const calls = stubFetch({
      createOrganization: { id: 'org-1' },
      createBranch: { id: 'branch-1' }
    });

    const output = await runOperation(
      db,
      'provisioning.ringotelSetup',
      { domain: 'testco', region: '3', packageid: 1 },
      asRun()
    );

    expect(output).toEqual({
      ringotelOrgId: 'org-1',
      ringotelBranchId: 'branch-1'
    });
    // The region and package lists come first (`assertOffered`), then the organization.
    expect(calls.slice(0, 2).map(call => call.method)).toEqual([
      'getRegions',
      'getPackages'
    ]);
    expect(calls[2]).toEqual({
      method: 'createOrganization',
      params: {
        name: 'Test Co',
        domain: 'testco',
        region: '3',
        packageid: 1,
        params: { hidePassInEmail: true, lang: 'de' }
      }
    });
    expect(calls[3]?.method).toBe('createBranch');
    expect(calls[3]?.params.orgid).toBe('org-1');
    expect(calls[3]?.params.address).toBe('pbx.example.com:5061');
    const provision = calls[3]?.params.provision as {
      protocol: string;
      features: string;
      codecs: { codec: string; frame: number }[];
      dnd: { on: string; off: string };
      vmail: { ext: string };
      callpark: { slots: { alias: string; slot: string }[] };
      maxregs: number;
      blfs: unknown[];
    };
    expect(provision.protocol).toBe('sips');
    expect(provision.features).toBe('pbx');
    // Default `settings.codecs_json`/`feature_codes_json`/`ringotel_max_regs` (db/migrations),
    // since `seedSettings` leaves these columns at their schema defaults.
    expect(provision.codecs).toEqual([
      { codec: 'Opus', frame: 20 },
      { codec: 'G.711 Alaw', frame: 20 }
    ]);
    expect(provision.dnd).toEqual({ on: '*90', off: '*91' });
    expect(provision.vmail.ext).toBe('*96');
    expect(provision.callpark.slots).toEqual([
      { alias: 'Parking 701', slot: '701' }
    ]);
    expect(provision.maxregs).toBe(3);
    // Every user and group extension (§11.2 `device_blf_keys`); the slot shows through
    // `callpark.slots` above, never as a colleague lamp.
    expect(provision.blfs).toEqual([]);

    const settingsRow = await db
      .selectFrom('settings')
      .select(['ringotelOrgId', 'ringotelBranchId'])
      .where('id', '=', 1)
      .executeTakeFirstOrThrow();
    expect(settingsRow).toEqual({
      ringotelOrgId: 'org-1',
      ringotelBranchId: 'branch-1'
    });
  });

  it('records its entry non-undoable, since no operation writes the ids back', async () => {
    const db = await makeTestDb();
    await seedSettings(db);
    stubFetch({
      createOrganization: { id: 'org-1' },
      createBranch: { id: 'branch-1' }
    });

    await runOperation(
      db,
      'provisioning.ringotelSetup',
      { domain: 'testco', region: '3', packageid: 1 },
      asRun()
    );

    const entry = await db
      .selectFrom('auditLog')
      .select('undoable')
      .where('operation', '=', 'provisioning.ringotelSetup')
      .executeTakeFirstOrThrow();
    expect(entry.undoable).toBe(0);
  });

  it('refuses a second run with 409, creating no second organization', async () => {
    const db = await makeTestDb();
    await seedSettings(db);
    const ringotel = installRingotelFake([]);
    const first = { domain: 'testco', region: '3', packageid: 1 };
    await runOperation(db, 'provisioning.ringotelSetup', first, asRun());
    const callsAfterFirst = ringotel.calls.length;

    await expect(
      runOperation(
        db,
        'provisioning.ringotelSetup',
        { ...first, domain: 'otherco' },
        asRun()
      )
    ).rejects.toMatchObject({ status: 409 });

    expect(ringotel.calls).toHaveLength(callsAfterFirst);
    expect(ringotel.organizations).toHaveLength(1);
  });

  it('is refused with 503 while ORIGIN is not set', async () => {
    const db = await makeTestDb();
    await seedSettings(db);
    stubFetch({ createOrganization: { id: 'org-1' } });
    const previousOrigin = process.env.ORIGIN;
    delete process.env.ORIGIN;

    try {
      await expect(
        runOperation(
          db,
          'provisioning.ringotelSetup',
          { domain: 'testco', region: '3', packageid: 1 },
          asRun()
        )
      ).rejects.toMatchObject({ status: 503 });
    } finally {
      process.env.ORIGIN = previousOrigin;
    }
  });

  it('is refused below owner', async () => {
    const db = await makeTestDb();
    await seedSettings(db);
    stubFetch({});

    await expect(
      runOperation(
        db,
        'provisioning.ringotelSetup',
        { domain: 'testco', region: '3', packageid: 1 },
        asRun({ actor: { id: 'admin-1', name: 'Admin', role: 'admin' } })
      )
    ).rejects.toThrow();
  });
  it('checks its ORIGIN precondition before creating the organization', async () => {
    const db = await makeTestDb();
    await seedSettings(db);
    const calls = stubFetch({
      createOrganization: { id: 'org-1' },
      createBranch: { id: 'branch-1' }
    });
    const origin = process.env.ORIGIN;
    delete process.env.ORIGIN;

    try {
      const attempt = runOperation(
        db,
        'provisioning.ringotelSetup',
        { domain: 'testco', region: '3', packageid: 1 },
        asRun()
      );
      await expect(attempt).rejects.toMatchObject({ status: 503 });
    } finally {
      process.env.ORIGIN = origin;
    }
    expect(calls).toEqual([]);
  });

  it('deletes the organization again when the connection fails, so a retry succeeds', async () => {
    const db = await makeTestDb();
    await seedSettings(db);
    const ringotel = installRingotelFake([]);
    ringotel.failing.add('createBranch');

    await expect(
      runOperation(
        db,
        'provisioning.ringotelSetup',
        { domain: 'testco', region: '3', packageid: 1 },
        asRun()
      )
    ).rejects.toThrow(/createBranch/u);
    expect(ringotel.organizations).toEqual([]);

    // The organization's domain is globally unique at Ringotel; an orphan would refuse this.
    ringotel.failing.delete('createBranch');
    const output = await runOperation<unknown, { ringotelOrgId: string }>(
      db,
      'provisioning.ringotelSetup',
      { domain: 'testco', region: '3', packageid: 1 },
      asRun()
    );
    expect(ringotel.organizations).toEqual([
      { id: output.ringotelOrgId, domain: 'testco' }
    ]);
  });

  it('deletes the organization again when the write after the connection fails', async () => {
    const db = await makeTestDb();
    await seedSettings(db);
    const ringotel = installRingotelFake([]);
    // The audit row is written after `run` returns, just before the commit.
    await sql`CREATE TRIGGER refuse_setup_audit BEFORE INSERT ON audit_log
      WHEN NEW.operation = 'provisioning.ringotelSetup'
      BEGIN SELECT RAISE(ABORT, 'audit write failed'); END`.execute(db);

    await expect(
      runOperation(
        db,
        'provisioning.ringotelSetup',
        { domain: 'testco', region: '3', packageid: 1 },
        asRun()
      )
    ).rejects.toThrow(/audit write failed/u);

    expect(ringotel.calls.map(call => call.method)).toEqual([
      'getRegions',
      'getPackages',
      'createOrganization',
      'createBranch',
      'deleteOrganization'
    ]);
    expect(ringotel.organizations).toEqual([]);
    const settingsRow = await db
      .selectFrom('settings')
      .select(['ringotelOrgId', 'ringotelBranchId'])
      .executeTakeFirstOrThrow();
    expect(settingsRow).toEqual({
      ringotelOrgId: null,
      ringotelBranchId: null
    });
  });

  it('names the organization it could not delete after a failed connection', async () => {
    const db = await makeTestDb();
    await seedSettings(db);
    const ringotel = installRingotelFake([]);
    ringotel.failing.add('createBranch');
    ringotel.failing.add('deleteOrganization');

    await expect(
      runOperation(
        db,
        'provisioning.ringotelSetup',
        { domain: 'testco', region: '3', packageid: 1 },
        asRun()
      )
    ).rejects.toThrow(
      /organization org-\d+ .*delete it in the Ringotel Shell/u
    );
  });
});
