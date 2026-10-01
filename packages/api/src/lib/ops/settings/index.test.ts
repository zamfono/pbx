import { afterEach, describe, expect, it } from 'vitest';

import {
  DEFAULT_FEATURE_CODES,
  newId,
  nowIso,
  type Db,
  type ReloadKind
} from '@zamfono/shared';

import { encrypt, keyringFromEnv } from '../../secretbox.js';
import { makeTestDb } from '../../testDb.js';
import { onPropagate, runOperation, type RunInput } from '../runner.js';
import { type Actor } from '../types.js';

import './index.js';

// settings.update encrypts smtpPassword/ssoClientSecret/ringotelApiToken via secretbox (§5.4),
// which needs a key even for the fields these tests never set.
process.env.SECRETBOX_KEY ??= `1:${Buffer.alloc(32, 7).toString('base64')}`;

const owner: Actor = { id: 'owner', name: 'Owner', role: 'owner' };
const admin: Actor = { id: 'admin-1', name: 'Admin', role: 'admin' };

function asRun(overrides: Partial<RunInput> = {}): RunInput {
  return { actor: owner, channel: 'rest', requestId: 'req-1', ...overrides };
}

/** Inserts a live `dids` row targeting an external number, returning its id. */
async function insertDid(db: Db, number: string): Promise<string> {
  const targetId = newId();
  await db
    .insertInto('forwardTargets')
    .values({
      id: targetId,
      userId: null,
      ringGroupId: null,
      external: number,
      mailboxUserId: null,
      mailboxRingGroupId: null,
      announcementAudioId: null,
      menuId: null
    })
    .execute();
  const id = newId();
  await db
    .insertInto('dids')
    .values({ id, number, label: null, targetId, createdAt: nowIso() })
    .execute();
  return id;
}

/** Seeds the tenant `settings` singleton, required by every settings operation. */
async function seedSettings(db: Db): Promise<void> {
  const mainDidId = await insertDid(db, '+490000000');
  await db
    .insertInto('settings')
    .values({
      id: 1,
      companyName: 'Test Co',
      country: 'DE',
      emergencyNumbersJson: '["112"]',
      mainDidId
    })
    .execute();
}

/** Marks the tenant as already provisioned with Ringotel, so `activeRingotelProvider` pushes. */
async function enableRingotel(db: Db): Promise<void> {
  await db
    .updateTable('settings')
    .set({
      ringotelOrgId: 'org-1',
      ringotelBranchId: 'branch-1',
      ringotelApiTokenEnc: encrypt(keyringFromEnv(process.env), 'ringotel-key')
    })
    .where('id', '=', 1)
    .execute();
}

type FetchCall = { method: string; params?: Record<string, unknown> };

/** Stubs `globalThis.fetch` to record every Ringotel RPC call (§10.4), as `ops/provisioning`. */
function stubFetch(results: Record<string, unknown> = {}): FetchCall[] {
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

describe('settings', () => {
  it('masks secret fields on read', async () => {
    const db = await makeTestDb();
    await seedSettings(db);
    await runOperation(
      db,
      'settings.update',
      { smtpHost: 'mail.example.com', smtpPassword: 'sekret' },
      asRun()
    );
    const settings = await runOperation<
      unknown,
      { smtpPassword: string | null; smtpHost: string | null }
    >(db, 'settings.get', {}, asRun());
    expect(settings.smtpHost).toBe('mail.example.com');
    expect(settings.smtpPassword).toBe('***');
  });

  // §3.1 "Config propagation": `core` reads `language` (§9.1, §9.4 "Cross-trunk failover") from
  // a cache it only drops once told to, whether or not Asterisk needs a reload alongside it — the
  // bug an `outbound-routes-exhausted` integration run surfaced: `core` kept the tenant's
  // previous language until an unrelated PJSIP-reloading write happened to refresh it too.
  it('propagates a column change that names no reload kind, language among them', async () => {
    const db = await makeTestDb();
    await seedSettings(db);
    const propagated: { operation: string; kind: ReloadKind[] }[] = [];
    onPropagate(change => {
      propagated.push(change);
      return Promise.resolve();
    });

    await runOperation(db, 'settings.update', { language: 'de' }, asRun());

    expect(propagated).toEqual([{ operation: 'settings.update', kind: [] }]);
  });

  it('propagates nothing for a settings.update that changed no column', async () => {
    const db = await makeTestDb();
    await seedSettings(db);
    await runOperation(db, 'settings.update', { language: 'de' }, asRun());
    const propagated: { operation: string; kind: ReloadKind[] }[] = [];
    onPropagate(change => {
      propagated.push(change);
      return Promise.resolve();
    });

    // The tenant is already `de`: nothing in `columns` changes, so this write, unlike the one
    // above, has nothing for `core` to re-read.
    await runOperation(db, 'settings.update', { language: 'de' }, asRun());

    expect(propagated).toEqual([]);
  });

  it('refuses an owner-only field for an admin and allows it for an owner', async () => {
    const db = await makeTestDb();
    await seedSettings(db);
    await expect(
      runOperation(
        db,
        'settings.update',
        { smtpHost: 'mail.example.com' },
        asRun({ actor: admin })
      )
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      runOperation(
        db,
        'settings.update',
        { smtpHost: 'mail.example.com' },
        asRun({ actor: owner })
      )
    ).resolves.toMatchObject({ smtpHost: 'mail.example.com' });
  });

  it('lets only an owner switch automatic updates on (§6.3 "Updates")', async () => {
    const db = await makeTestDb();
    await seedSettings(db);
    await expect(
      runOperation(
        db,
        'settings.update',
        { autoUpdate: true },
        asRun({ actor: admin })
      )
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      runOperation(
        db,
        'settings.update',
        { autoUpdate: true },
        asRun({ actor: owner })
      )
    ).resolves.toMatchObject({ autoUpdate: true });
    await expect(
      runOperation(db, 'settings.get', {}, asRun({ actor: owner }))
    ).resolves.toMatchObject({ autoUpdate: true });
  });

  it('rejects the read-only extLength field', async () => {
    const db = await makeTestDb();
    await seedSettings(db);
    await expect(
      runOperation(db, 'settings.update', { extLength: 4 }, asRun())
    ).rejects.toMatchObject({ status: 422 });
  });

  it('clears every users.sso_subject when ssoIssuer changes', async () => {
    const db = await makeTestDb();
    await seedSettings(db);
    await db
      .updateTable('users')
      .set({ ssoSubject: 'sub-1' })
      .where('id', '=', 'owner')
      .execute();
    await runOperation(
      db,
      'settings.update',
      {
        ssoProvider: 'oidc',
        ssoLabel: 'Corp SSO',
        ssoIssuer: 'https://issuer.example',
        ssoClientId: 'client-1'
      },
      asRun()
    );
    const user = await db
      .selectFrom('users')
      .select('ssoSubject')
      .where('id', '=', 'owner')
      .executeTakeFirstOrThrow();
    expect(user.ssoSubject).toBeNull();
  });

  it('persists callLogLevel and ssoProvider to their columns', async () => {
    const db = await makeTestDb();
    await seedSettings(db);
    await runOperation(
      db,
      'settings.update',
      {
        callLogLevel: 'qos',
        ssoProvider: 'oidc',
        ssoLabel: 'Corp SSO',
        ssoIssuer: 'https://issuer.example',
        ssoClientId: 'client-1'
      },
      asRun()
    );
    const row = await db
      .selectFrom('settings')
      .select(['callLogLevel', 'ssoProvider'])
      .where('id', '=', 1)
      .executeTakeFirstOrThrow();
    expect(row.callLogLevel).toBe('qos');
    expect(row.ssoProvider).toBe('oidc');
  });

  it('rejects an sso combination that would violate the §11.2 CHECK constraints', async () => {
    const db = await makeTestDb();
    await seedSettings(db);
    await expect(
      runOperation(
        db,
        'settings.update',
        { ssoProvider: 'microsoft', ssoClientId: 'client-1' },
        asRun()
      )
    ).rejects.toMatchObject({ status: 422 });
  });

  it('pushes onTenantProfileChanged on a codecs change once Ringotel is provisioned (§10.4)', async () => {
    const db = await makeTestDb();
    await seedSettings(db);
    await enableRingotel(db);
    const calls = stubFetch();

    await runOperation(db, 'settings.update', { codecs: ['opus'] }, asRun());

    // onTenantProfileChanged always pushes both the branch profile and the organization's
    // language (§10.4), whichever of the three fields triggered it.
    expect(calls.map(call => call.method)).toEqual([
      'updateBranch',
      'updateOrganization'
    ]);
    expect(
      (calls[0]?.params?.provision as { codecs: unknown[] }).codecs
    ).toEqual([{ codec: 'Opus', frame: 20 }]);
  });

  it('pushes onTenantProfileChanged on a language change once Ringotel is provisioned (§10.4)', async () => {
    const db = await makeTestDb();
    await seedSettings(db);
    await enableRingotel(db);
    const calls = stubFetch();

    await runOperation(db, 'settings.update', { language: 'fr' }, asRun());

    expect(calls[1]).toEqual({
      method: 'updateOrganization',
      params: {
        id: 'org-1',
        params: { hidePassInEmail: true, lang: 'fr' }
      }
    });
  });

  it('pushes the branch profile on a feature-code change, which it carries (§10.4)', async () => {
    const db = await makeTestDb();
    await seedSettings(db);
    await enableRingotel(db);
    const calls = stubFetch();

    await runOperation(
      db,
      'settings.update',
      {
        featureCodes: {
          ...DEFAULT_FEATURE_CODES,
          dndOn: '*78',
          ownVoicemail: '*76',
          park: '*60'
        }
      },
      asRun()
    );

    const provision = calls.find(call => call.method === 'updateBranch')?.params
      ?.provision as {
      dnd: { on: string };
      vmail: { ext: string };
      callpark: { park: string };
    };
    expect(provision.dnd.on).toBe('*78');
    expect(provision.vmail.ext).toBe('*76');
    expect(provision.callpark.park).toBe('*60');
  });

  it('pushes the branch profile on an emergency-number change, which it carries (§10.1, §10.4)', async () => {
    const db = await makeTestDb();
    await seedSettings(db);
    await enableRingotel(db);
    const calls = stubFetch();

    await runOperation(
      db,
      'settings.update',
      { emergencyNumbers: ['112', '110'] },
      asRun()
    );

    const provision = calls.find(call => call.method === 'updateBranch')?.params
      ?.provision as { emergency: { title: string; number: string }[] };
    expect(provision.emergency).toEqual([
      { title: '112', number: '112' },
      { title: '110', number: '110' }
    ]);
  });

  it('pushes nothing on an unrelated field even once Ringotel is provisioned', async () => {
    const db = await makeTestDb();
    await seedSettings(db);
    await enableRingotel(db);
    const calls = stubFetch();

    await runOperation(
      db,
      'settings.update',
      { smtpHost: 'mail.example.com' },
      asRun()
    );

    expect(calls).toEqual([]);
  });
  it('refuses a country that names no calling code, with 422', async () => {
    const db = await makeTestDb();
    await seedSettings(db);

    const attempt = runOperation(
      db,
      'settings.update',
      { country: 'XX' },
      asRun()
    );

    await expect(attempt).rejects.toMatchObject({ status: 422 });
    const row = await db
      .selectFrom('settings')
      .select('country')
      .where('id', '=', 1)
      .executeTakeFirstOrThrow();
    expect(row.country).toBe('DE');
  });

  it('refuses an emergency number a live extension already holds', async () => {
    const db = await makeTestDb();
    await seedSettings(db);
    await db
      .insertInto('extensions')
      .values({ ext: '110', userId: null, ringGroupId: null, isParkingSlot: 1 })
      .execute();
    // Dialling resolves an emergency number before any extension (§9.4), so adopting one an
    // extension holds would leave that extension unreachable with no sign of why.
    await expect(
      runOperation(
        db,
        'settings.update',
        { emergencyNumbers: ['112', '110'] },
        asRun()
      )
    ).rejects.toMatchObject({ status: 422 });
  });

  it('accepts a country that names a calling code', async () => {
    const db = await makeTestDb();
    await seedSettings(db);

    await runOperation(db, 'settings.update', { country: 'AT' }, asRun());

    const row = await db
      .selectFrom('settings')
      .select('country')
      .where('id', '=', 1)
      .executeTakeFirstOrThrow();
    expect(row.country).toBe('AT');
  });

  it('refuses a timezone that is no IANA time zone, with 422 (§11.4)', async () => {
    const db = await makeTestDb();
    await seedSettings(db);

    for (const timezone of ['Mars/Olympus', '+01:00', '']) {
      // eslint-disable-next-line no-await-in-loop -- each refusal is asserted in turn
      await expect(
        runOperation(db, 'settings.update', { timezone }, asRun())
      ).rejects.toMatchObject({ status: 422 });
    }
    await expect(
      runOperation(
        db,
        'settings.update',
        { timezone: 'Europe/Berlin' },
        asRun()
      )
    ).resolves.toMatchObject({ timezone: 'Europe/Berlin' });
    await expect(
      runOperation(db, 'settings.update', { timezone: null }, asRun())
    ).resolves.toMatchObject({ timezone: null });
  });

  it('refuses a backupCron the backup scheduler cannot parse, with 422 (§11.4)', async () => {
    const db = await makeTestDb();
    await seedSettings(db);

    for (const backupCron of ['bogus', '61 * * * *', '0 0 30 2 *']) {
      // eslint-disable-next-line no-await-in-loop -- each refusal is asserted in turn
      await expect(
        runOperation(db, 'settings.update', { backupCron }, asRun())
      ).rejects.toMatchObject({ status: 422 });
    }
    await expect(
      runOperation(
        db,
        'settings.update',
        { backupCron: '30 2 * * 1-5' },
        asRun()
      )
    ).resolves.toMatchObject({ backupCron: '30 2 * * 1-5' });
  });
});
