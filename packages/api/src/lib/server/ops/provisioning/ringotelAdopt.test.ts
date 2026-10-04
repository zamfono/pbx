import * as privateEnv from '$app/env/private';
import { afterEach, describe, expect, it } from 'vitest';

import { type Db } from '@zamfono/shared';
import { seedSettings } from '@zamfono/shared/testDb.js';

import { encrypt, keyringFromEnv } from '#lib/server/secretbox.js';
import {
  installRingotelFake,
  type RingotelFake
} from '#testing/ringotelFake.js';
import { FAKE_PACKAGES, FAKE_REGIONS } from '#testing/ringotelFakeHandlers.js';
import { asConfirmedRun, makeTestDb } from '#testing/testDb.js';

import { runOperation } from '../runner.js';

import '../settings/index.js';
import './index.js';

process.env.FQDN = 'pbx.example.com';

// The account holds another customer's organization beside the one to adopt, as the live one
// does: adoption must never reach it.
const TARGET = { id: 'org-9', domain: 'zamfono-test' };
const OTHER_CUSTOMER = { id: 'org-7', domain: 'another-customer' };
// The connection the Ringotel Shell creates with an organization: it points nowhere yet.
const SHELL_BRANCH = { id: 'branch-default', orgid: 'org-9', address: '' };
const WRITES = [
  'createBranch',
  'updateBranch',
  'updateOrganization',
  'createUser',
  'updateUser'
];

async function storedIds(
  db: Db
): Promise<{ ringotelOrgId: string | null; ringotelBranchId: string | null }> {
  return db
    .selectFrom('settings')
    .select(['ringotelOrgId', 'ringotelBranchId'])
    .executeTakeFirstOrThrow();
}

function writesMade(fake: RingotelFake): string[] {
  return fake.calls
    .map(call => call.method)
    .filter(method => WRITES.includes(method));
}

// The fake a test installed, put back after it.
let installed: RingotelFake | undefined;

function install(
  ...args: Parameters<typeof installRingotelFake>
): RingotelFake {
  installed = installRingotelFake(...args);
  return installed;
}

afterEach(() => {
  installed?.restore();
  installed = undefined;
});

describe('provisioning.ringotelAdopt', () => {
  it('points the named connection at this stack and stores both ids', async () => {
    const db = await makeTestDb();
    await seedSettings(db, {
      language: 'de',
      ringotelApiTokenEnc: encrypt(keyringFromEnv(privateEnv), 'ringotel-key')
    });
    const fake = install([OTHER_CUSTOMER, TARGET], [SHELL_BRANCH]);

    const output = await runOperation(
      db,
      'provisioning.ringotelAdopt',
      { orgId: 'org-9', domain: 'zamfono-test', branchId: 'branch-default' },
      asConfirmedRun()
    );

    expect(output).toEqual({
      ringotelOrgId: 'org-9',
      ringotelBranchId: 'branch-default'
    });
    expect(await storedIds(db)).toEqual(output);
    expect(fake.branches).toEqual([
      { ...SHELL_BRANCH, address: 'pbx.example.com:5061' }
    ]);
    const orgUpdate = fake.calls.find(
      call => call.method === 'updateOrganization'
    );
    expect(orgUpdate?.params).toEqual({
      id: 'org-9',
      params: { hidePassInEmail: true, lang: 'de' }
    });
  });

  it('creates a connection of its own when none is named', async () => {
    const db = await makeTestDb();
    await seedSettings(db, {
      language: 'de',
      ringotelApiTokenEnc: encrypt(keyringFromEnv(privateEnv), 'ringotel-key')
    });
    const fake = install([TARGET]);

    const output = (await runOperation(
      db,
      'provisioning.ringotelAdopt',
      { orgId: 'org-9', domain: 'zamfono-test' },
      asConfirmedRun()
    )) as { ringotelBranchId: string };

    expect(fake.branches).toEqual([
      {
        id: output.ringotelBranchId,
        orgid: 'org-9',
        address: 'pbx.example.com:5061'
      }
    ]);
    expect(await storedIds(db)).toEqual({
      ringotelOrgId: 'org-9',
      ringotelBranchId: output.ringotelBranchId
    });
  });

  it("refuses an id whose domain differs, even another customer's, writing nothing", async () => {
    const db = await makeTestDb();
    await seedSettings(db, {
      language: 'de',
      ringotelApiTokenEnc: encrypt(keyringFromEnv(privateEnv), 'ringotel-key')
    });
    const fake = install([OTHER_CUSTOMER, TARGET]);

    await expect(
      runOperation(
        db,
        'provisioning.ringotelAdopt',
        { orgId: 'org-7', domain: 'zamfono-test' },
        asConfirmedRun()
      )
    ).rejects.toMatchObject({ status: 404 });
    expect(writesMade(fake)).toEqual([]);
    expect(await storedIds(db)).toEqual({
      ringotelOrgId: null,
      ringotelBranchId: null
    });
  });

  it('refuses an organization that already has users', async () => {
    const db = await makeTestDb();
    await seedSettings(db, {
      language: 'de',
      ringotelApiTokenEnc: encrypt(keyringFromEnv(privateEnv), 'ringotel-key')
    });
    const fake = install([TARGET]);
    fake.users.push({
      id: 'ru-1',
      extension: '100',
      username: '100',
      authname: '100',
      name: 'Someone',
      email: 'someone@example.com',
      password: 'x'
    });

    await expect(
      runOperation(
        db,
        'provisioning.ringotelAdopt',
        { orgId: 'org-9', domain: 'zamfono-test' },
        asConfirmedRun()
      )
    ).rejects.toMatchObject({ status: 409 });
    expect(writesMade(fake)).toEqual([]);
  });

  it('refuses a connection the organization does not have', async () => {
    const db = await makeTestDb();
    await seedSettings(db, {
      language: 'de',
      ringotelApiTokenEnc: encrypt(keyringFromEnv(privateEnv), 'ringotel-key')
    });
    const fake = install([TARGET], [SHELL_BRANCH]);

    await expect(
      runOperation(
        db,
        'provisioning.ringotelAdopt',
        { orgId: 'org-9', domain: 'zamfono-test', branchId: 'branch-x' },
        asConfirmedRun()
      )
    ).rejects.toMatchObject({ status: 404 });
    expect(writesMade(fake)).toEqual([]);
  });

  it('refuses a stack that is already set up', async () => {
    const db = await makeTestDb();
    await seedSettings(db, {
      language: 'de',
      ringotelApiTokenEnc: encrypt(keyringFromEnv(privateEnv), 'ringotel-key')
    });
    await db
      .updateTable('settings')
      .set({ ringotelOrgId: 'org-1', ringotelBranchId: 'branch-1' })
      .execute();
    const fake = install([TARGET]);

    await expect(
      runOperation(
        db,
        'provisioning.ringotelAdopt',
        { orgId: 'org-9', domain: 'zamfono-test' },
        asConfirmedRun()
      )
    ).rejects.toMatchObject({ status: 409 });
    expect(fake.calls).toEqual([]);
  });

  it('deletes the connection it created when a later step fails', async () => {
    const db = await makeTestDb();
    await seedSettings(db, {
      language: 'de',
      ringotelApiTokenEnc: encrypt(keyringFromEnv(privateEnv), 'ringotel-key')
    });
    const fake = install([TARGET]);
    fake.failing.add('updateOrganization');

    await expect(
      runOperation(
        db,
        'provisioning.ringotelAdopt',
        { orgId: 'org-9', domain: 'zamfono-test' },
        asConfirmedRun()
      )
    ).rejects.toThrow();
    expect(fake.branches).toEqual([]);
    expect(await storedIds(db)).toEqual({
      ringotelOrgId: null,
      ringotelBranchId: null
    });
  });
});

describe('provisioning.ringotelOptions', () => {
  it('lists the regions and packages the account offers', async () => {
    const db = await makeTestDb();
    await seedSettings(db, {
      language: 'de',
      ringotelApiTokenEnc: encrypt(keyringFromEnv(privateEnv), 'ringotel-key')
    });
    install();

    expect(
      await runOperation(
        db,
        'provisioning.ringotelOptions',
        {},
        asConfirmedRun()
      )
    ).toEqual({ regions: FAKE_REGIONS, packages: FAKE_PACKAGES });
  });
});

describe('provisioning.ringotelSetup with a region the account does not offer', () => {
  it('is refused before anything is created, naming the regions offered', async () => {
    const db = await makeTestDb();
    await seedSettings(db, {
      language: 'de',
      ringotelApiTokenEnc: encrypt(keyringFromEnv(privateEnv), 'ringotel-key')
    });
    const fake = install([]);

    await expect(
      runOperation(
        db,
        'provisioning.ringotelSetup',
        { domain: 'testco', region: 'Europe Frankfurt', packageid: 2 },
        asConfirmedRun()
      )
    ).rejects.toThrow(/choose one of 3 \(Europe \(Frankfurt\)\)/u);
    expect(fake.organizations).toEqual([]);
  });
});

describe('the registrations per user follow the package (§10.4, §11.4)', () => {
  async function maxRegs(db: Db): Promise<number> {
    return (
      await db
        .selectFrom('settings')
        .select('ringotelMaxRegs')
        .executeTakeFirstOrThrow()
    ).ringotelMaxRegs;
  }

  it("setup takes the chosen package's, Pro's 6", async () => {
    const db = await makeTestDb();
    await seedSettings(db, {
      language: 'de',
      ringotelApiTokenEnc: encrypt(keyringFromEnv(privateEnv), 'ringotel-key')
    });
    install([]);

    await runOperation(
      db,
      'provisioning.ringotelSetup',
      { domain: 'testco', region: '3', packageid: 2 },
      asConfirmedRun()
    );

    expect(await maxRegs(db)).toBe(6);
  });

  it("adopt takes the adopted organization's package's", async () => {
    const db = await makeTestDb();
    await seedSettings(db, {
      language: 'de',
      ringotelApiTokenEnc: encrypt(keyringFromEnv(privateEnv), 'ringotel-key')
    });
    install([{ ...TARGET, packageid: 2 }]);

    await runOperation(
      db,
      'provisioning.ringotelAdopt',
      { orgId: 'org-9', domain: 'zamfono-test' },
      asConfirmedRun()
    );

    expect(await maxRegs(db)).toBe(6);
  });

  it('leaves a value an owner set alone', async () => {
    const db = await makeTestDb();
    await seedSettings(db, {
      language: 'de',
      ringotelApiTokenEnc: encrypt(keyringFromEnv(privateEnv), 'ringotel-key')
    });
    await db.updateTable('settings').set({ ringotelMaxRegs: 4 }).execute();
    install([]);

    await runOperation(
      db,
      'provisioning.ringotelSetup',
      { domain: 'testco', region: '3', packageid: 2 },
      asConfirmedRun()
    );

    expect(await maxRegs(db)).toBe(4);
  });
});

describe('provisioning.ringotelSetup with a domain the account already has', () => {
  it('answers 409 naming the organization and the adoption that takes it over', async () => {
    const db = await makeTestDb();
    await seedSettings(db, {
      language: 'de',
      ringotelApiTokenEnc: encrypt(keyringFromEnv(privateEnv), 'ringotel-key')
    });
    const fake = install([TARGET]);

    await expect(
      runOperation(
        db,
        'provisioning.ringotelSetup',
        { domain: 'zamfono-test', region: '3', packageid: 2 },
        asConfirmedRun()
      )
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      runOperation(
        db,
        'provisioning.ringotelSetup',
        { domain: 'zamfono-test', region: '3', packageid: 2 },
        asConfirmedRun()
      )
    ).rejects.toThrow(
      "provisioning.ringotelAdopt { orgId: 'org-9', domain: 'zamfono-test' }"
    );
    expect(fake.organizations).toEqual([TARGET]);
  });
});

describe("the connection carries the tenant's country (§10.4)", () => {
  it('is created with it, and pushed again when the country changes', async () => {
    const db = await makeTestDb();
    await seedSettings(db, {
      language: 'de',
      ringotelApiTokenEnc: encrypt(keyringFromEnv(privateEnv), 'ringotel-key')
    });
    const fake = install([]);

    await runOperation(
      db,
      'provisioning.ringotelSetup',
      { domain: 'testco', region: '3', packageid: 2 },
      asConfirmedRun()
    );
    const created = fake.calls.find(call => call.method === 'createBranch');
    expect(created?.params.country).toBe('DE');

    fake.calls.length = 0;
    await runOperation(
      db,
      'settings.update',
      { country: 'AT' },
      asConfirmedRun()
    );
    const pushed = fake.calls.find(call => call.method === 'updateBranch');
    expect(pushed?.params.country).toBe('AT');
  });
});
