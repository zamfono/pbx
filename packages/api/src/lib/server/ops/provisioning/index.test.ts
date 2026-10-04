import * as privateEnv from '$app/env/private';
import { sql } from 'kysely';
import { afterEach, describe, expect, it } from 'vitest';

import { type Db } from '@zamfono/shared';

import { encrypt, keyringFromEnv } from '#lib/server/secretbox.js';
import { installRingotelFake } from '#testing/ringotelFake.js';
import { FAKE_PACKAGES, FAKE_REGIONS } from '#testing/ringotelFakeHandlers.js';
import { asRun, makeTestDb, seedSettings } from '#testing/testDb.js';

import { runOperation } from '../runner.js';

import './index.js';

process.env.FQDN = 'pbx.example.com';

/** Seeds `settings` with a Ringotel API token and no organization/connection yet. */
async function seedTenant(db: Db): Promise<void> {
  await seedSettings(db, {
    language: 'de',
    ringotelApiTokenEnc: encrypt(keyringFromEnv(privateEnv), 'ringotel-key')
  });
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
    await seedTenant(db);
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
    await seedTenant(db);
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

  it.each([
    { region: 'nowhere', packageid: 1 },
    { region: '3', packageid: 999 }
  ])(
    'refuses a region or package the account does not offer with 422, creating nothing: %o',
    async offer => {
      const db = await makeTestDb();
      await seedTenant(db);
      const ringotel = installRingotelFake([]);

      await expect(
        runOperation(
          db,
          'provisioning.ringotelSetup',
          { domain: 'testco', ...offer },
          asRun()
        )
      ).rejects.toMatchObject({ status: 422 });

      expect(ringotel.organizations).toHaveLength(0);
    }
  );

  it('refuses a second run with 409, creating no second organization', async () => {
    const db = await makeTestDb();
    await seedTenant(db);
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

  it('is refused below owner', async () => {
    const db = await makeTestDb();
    await seedTenant(db);
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

  it('deletes the organization again when the connection fails, so a retry succeeds', async () => {
    const db = await makeTestDb();
    await seedTenant(db);
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
    const output = (await runOperation(
      db,
      'provisioning.ringotelSetup',
      { domain: 'testco', region: '3', packageid: 1 },
      asRun()
    )) as { ringotelOrgId: string };
    expect(ringotel.organizations).toEqual([
      { id: output.ringotelOrgId, domain: 'testco' }
    ]);
  });

  it('deletes the organization again when the write after the connection fails', async () => {
    const db = await makeTestDb();
    await seedTenant(db);
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
    await seedTenant(db);
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
