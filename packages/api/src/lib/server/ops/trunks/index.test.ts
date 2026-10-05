import { afterEach, describe, expect, it, vi } from 'vitest';

import { getCoreClient } from '#lib/server/coreClient.js';
import { stubCoreClient } from '#testing/coreClientStub.js';
import { createTrunk } from '#testing/fixtures.js';
import { asRun, makeTestDb } from '#testing/testDb.js';

import { runOperation } from '../runner.js';

import '../outboundRoutes/index.js';
import './index.js';

describe('trunks operations', () => {
  const originalSipUdpEnabled = process.env.SIP_UDP_ENABLED;

  afterEach(() => {
    if (originalSipUdpEnabled === undefined) {
      delete process.env.SIP_UDP_ENABLED;
    } else {
      process.env.SIP_UDP_ENABLED = originalSipUdpEnabled;
    }
  });

  it('inserts the catch-all outbound route, with empty caller and number lists, alongside the first trunk', async () => {
    const db = await makeTestDb();
    const { trunk } = await createTrunk(db);
    const routes = await db
      .selectFrom('outboundRoutes')
      .selectAll()
      .where('deletedAt', 'is', null)
      .execute();
    expect(routes).toHaveLength(1);
    expect(routes[0]).toMatchObject({ trunkId: trunk.id, priority: 1 });
    const [users, userGroups, numbers] = await Promise.all([
      db.selectFrom('outboundRouteUsers').selectAll().execute(),
      db.selectFrom('outboundRouteUserGroups').selectAll().execute(),
      db.selectFrom('outboundRouteNumbers').selectAll().execute()
    ]);
    expect(users).toHaveLength(0);
    expect(userGroups).toHaveLength(0);
    expect(numbers).toHaveLength(0);
  });

  it('refuses a udp trunk while SIP_UDP_ENABLED=false', async () => {
    const db = await makeTestDb();
    process.env.SIP_UDP_ENABLED = 'false';
    await expect(createTrunk(db, { transport: 'udp' })).rejects.toMatchObject({
      status: 422
    });
  });

  it('refuses clir on a from-header trunk', async () => {
    const db = await makeTestDb();
    await expect(
      createTrunk(db, { clir: true, callerIdHeader: 'from' })
    ).rejects.toMatchObject({ status: 422 });
  });

  it("refuses 'pai' on a trunk without a username, the account identity, on create", async () => {
    const db = await makeTestDb();
    await expect(
      createTrunk(db, { callerIdHeader: 'pai' })
    ).rejects.toMatchObject({ status: 422, message: /username/u });
    const { trunk } = await createTrunk(db, {
      authMode: 'registration',
      username: 'alice',
      password: 's3cret',
      callerIdHeader: 'pai'
    });
    expect(trunk).toMatchObject({ callerIdHeader: 'pai' });
  });

  it("refuses an update that leaves a 'pai' trunk without a username", async () => {
    const db = await makeTestDb();
    const update = (input: Record<string, unknown>): Promise<unknown> =>
      runOperation(db, 'trunks.update', input, asRun());
    const { trunk: plain } = await createTrunk(db, { name: 'Plain' });
    await expect(
      update({ id: plain.id, callerIdHeader: 'pai' })
    ).rejects.toMatchObject({ status: 422, message: /username/u });

    const { trunk: registered } = await createTrunk(db, {
      name: 'Registered',
      authMode: 'registration',
      username: 'alice',
      password: 's3cret',
      callerIdHeader: 'pai'
    });
    await expect(
      update({ id: registered.id, authMode: 'ip' })
    ).rejects.toMatchObject({ status: 422, message: /username/u });

    const { trunk: inbound } = await createTrunk(db, {
      name: 'Inbound auth',
      inboundAuth: true,
      username: 'bob',
      password: 's3cret',
      callerIdHeader: 'pai'
    });
    await expect(
      update({ id: inbound.id, inboundAuth: false })
    ).rejects.toMatchObject({ status: 422, message: /username/u });
    await expect(
      update({ id: inbound.id, username: null })
    ).rejects.toMatchObject({ status: 422 });

    await update({
      id: inbound.id,
      inboundAuth: false,
      callerIdHeader: 'both'
    });
    const row = await db
      .selectFrom('trunks')
      .select(['callerIdHeader', 'username'])
      .where('id', '=', inbound.id)
      .executeTakeFirstOrThrow();
    expect(row).toEqual({ callerIdHeader: 'both', username: null });
  });

  it('refuses to delete a trunk still used by an outbound route, naming it', async () => {
    const db = await makeTestDb();
    const { trunk } = await createTrunk(db);
    const routes = await db.selectFrom('outboundRoutes').selectAll().execute();
    await expect(
      runOperation(
        db,
        'trunks.delete',
        { id: trunk.id },
        { ...asRun(), confirm: true }
      )
    ).rejects.toMatchObject({
      status: 409,
      references: [
        expect.objectContaining({ kind: 'outboundRoute', id: routes[0]?.id })
      ]
    });
  });

  it('records the trunk host list in the audit diff on create', async () => {
    const db = await makeTestDb();
    const { trunk } = await createTrunk(db, {
      hosts: [{ host: 'sip.provider.example', port: 5060 }]
    });
    const audit = await db
      .selectFrom('auditLog')
      .selectAll()
      .where('entityId', '=', trunk.id)
      .executeTakeFirstOrThrow();
    const changes = JSON.parse(audit.changesJson) as {
      field: string;
      from: unknown;
      to: unknown;
    }[];
    expect(changes.find(change => change.field === 'hosts')).toMatchObject({
      from: null,
      to: [{ host: 'sip.provider.example', port: 5060 }]
    });
  });

  it('records the prior host list in the audit diff on update, and warns about the explicit port', async () => {
    const db = await makeTestDb();
    const { trunk } = await createTrunk(db, {
      hosts: [{ host: 'sip.provider.example' }]
    });
    const result = (await runOperation(
      db,
      'trunks.update',
      {
        id: trunk.id,
        hosts: [{ host: 'sip.provider.example', port: 5060 }]
      },
      asRun()
    )) as { trunk: { id: string }; warnings: string[] };
    expect(result.warnings).toEqual(['host has explicit port; SRV disabled']);
    const audit = await db
      .selectFrom('auditLog')
      .selectAll()
      .where('entityId', '=', trunk.id)
      .where('operation', '=', 'trunks.update')
      .executeTakeFirstOrThrow();
    const changes = JSON.parse(audit.changesJson) as {
      field: string;
      from: unknown;
      to: unknown;
    }[];
    const hostsChange = changes.find(change => change.field === 'hosts');
    expect(hostsChange?.from).toMatchObject([
      { host: 'sip.provider.example', port: null }
    ]);
    expect(hostsChange?.to).toEqual([
      { host: 'sip.provider.example', port: 5060 }
    ]);
  });

  it('refuses a duplicate trunk name, naming the trunk holding it', async () => {
    const db = await makeTestDb();
    const { trunk: holder } = await createTrunk(db, { name: 'Provider A' });
    await expect(createTrunk(db, { name: 'Provider A' })).rejects.toMatchObject(
      {
        status: 409,
        references: [{ kind: 'trunk', id: holder.id, label: 'Provider A' }]
      }
    );
  });

  it('replays a recorded hosts and outboundProxy "from" value back through trunks.update (§5.8 undo)', async () => {
    const db = await makeTestDb();
    const { trunk } = await createTrunk(db, {
      hosts: [{ host: 'h1' }]
    });
    await runOperation(
      db,
      'trunks.update',
      {
        id: trunk.id,
        hosts: [{ host: 'h2', port: 5060 }],
        outboundProxy: 'sip:p.example'
      },
      asRun()
    );
    const audit = await db
      .selectFrom('auditLog')
      .selectAll()
      .where('entityId', '=', trunk.id)
      .where('operation', '=', 'trunks.update')
      .executeTakeFirstOrThrow();
    const changes = JSON.parse(audit.changesJson) as {
      field: string;
      from: unknown;
    }[];
    const hostsFrom = changes.find(change => change.field === 'hosts')?.from;
    const outboundProxyFrom = changes.find(
      change => change.field === 'outboundProxy'
    )?.from;
    expect(outboundProxyFrom).toBeNull();

    // Undo replays `from` through the normal operation; this must validate.
    await runOperation(
      db,
      'trunks.update',
      { id: trunk.id, hosts: hostsFrom, outboundProxy: outboundProxyFrom },
      asRun()
    );
    const row = await db
      .selectFrom('trunks')
      .select('outboundProxy')
      .where('id', '=', trunk.id)
      .executeTakeFirstOrThrow();
    expect(row.outboundProxy).toBeNull();
  });

  it('refuses username without password on a trunk that carries no credentials', async () => {
    const db = await makeTestDb();
    await expect(
      createTrunk(db, { authMode: 'ip', username: 'bob' })
    ).rejects.toMatchObject({ status: 422 });
  });

  it('refuses a port above 65535 on update, same as on create', async () => {
    const db = await makeTestDb();
    const { trunk } = await createTrunk(db);
    await expect(
      runOperation(
        db,
        'trunks.update',
        { id: trunk.id, hosts: [{ host: 'h1', port: 70000 }] },
        asRun()
      )
    ).rejects.toThrow();
  });

  it('refuses an unknown field on trunks.update', async () => {
    const db = await makeTestDb();
    const { trunk } = await createTrunk(db);
    await expect(
      runOperation(
        db,
        'trunks.update',
        { id: trunk.id, oubtoundProxy: 'typo.example' },
        asRun()
      )
    ).rejects.toThrow();
  });

  it('setOrder refuses a list missing a live trunk, and rewrites priorities 1..n for a valid one', async () => {
    const db = await makeTestDb();
    const first = await createTrunk(db, { name: 'Provider A' });
    const second = await createTrunk(db, { name: 'Provider B' });

    await expect(
      runOperation(
        db,
        'trunks.setOrder',
        { trunkIds: [first.trunk.id] },
        asRun()
      )
    ).rejects.toMatchObject({ status: 422 });

    await runOperation(
      db,
      'trunks.setOrder',
      { trunkIds: [second.trunk.id, first.trunk.id] },
      asRun()
    );
    const rows = await db
      .selectFrom('trunks')
      .select(['id', 'priority'])
      .orderBy('priority')
      .execute();
    expect(rows.map(row => row.id)).toEqual([second.trunk.id, first.trunk.id]);
    expect(rows.map(row => row.priority)).toEqual([1, 2]);
  });

  it('setOrder records the prior order as its "from", replayable through setOrder itself (§5.8 undo)', async () => {
    const db = await makeTestDb();
    const first = await createTrunk(db, { name: 'Provider A' });
    const second = await createTrunk(db, { name: 'Provider B' });

    await runOperation(
      db,
      'trunks.setOrder',
      { trunkIds: [second.trunk.id, first.trunk.id] },
      asRun()
    );
    const audit = await db
      .selectFrom('auditLog')
      .selectAll()
      .where('operation', '=', 'trunks.setOrder')
      .executeTakeFirstOrThrow();
    const changes = JSON.parse(audit.changesJson) as {
      field: string;
      from: unknown;
    }[];
    const from = changes.find(change => change.field === 'trunkIds')?.from;
    expect(from).toEqual([first.trunk.id, second.trunk.id]);

    // Undo replays `from` through the normal operation; this must validate and restore order.
    await runOperation(db, 'trunks.setOrder', { trunkIds: from }, asRun());
    const rows = await db
      .selectFrom('trunks')
      .select(['id', 'priority'])
      .orderBy('priority')
      .execute();
    expect(rows.map(row => row.id)).toEqual([first.trunk.id, second.trunk.id]);
  });

  it('answers status unknown for every trunk while core does not answer', async () => {
    const db = await makeTestDb();
    const { trunk } = await createTrunk(db);
    // Unstubbed, `getCoreClient()` fails every request, as an unreachable `core` does.
    const { items } = (await runOperation(db, 'trunks.list', {}, asRun())) as {
      items: {
        id: string;
        status: string;
        statusChangedAt: string | null;
      }[];
    };
    expect(items).toEqual([
      expect.objectContaining({
        status: 'unknown',
        statusChangedAt: null,
        registeredAt: null
      })
    ]);

    const one = (await runOperation(
      db,
      'trunks.get',
      { id: trunk.id },
      asRun()
    )) as { status: string; statusChangedAt: string | null };
    expect(one).toMatchObject({
      status: 'unknown',
      statusChangedAt: null,
      registeredAt: null
    });
  });

  it("answers the core's own status through the core's state (§9.4 Provisioning and status)", async () => {
    const db = await makeTestDb();
    const { trunk } = await createTrunk(db);
    const reported = {
      status: 'registered' as const,
      statusChangedAt: '2026-09-23T00:00:00.000Z',
      registeredAt: '2026-09-23T00:00:30.000Z'
    };
    vi.mocked(getCoreClient).mockReturnValue(
      stubCoreClient({
        state: () =>
          Promise.resolve({
            calls: [],
            trunks: { [trunk.id]: reported },
            trunkChannels: {},
            presence: {},
            registeredDevices: 0,
            recordingMixFailures: 0,
            asteriskChannels: 0,
            recordingsInProgress: 0
          })
      })
    );
    try {
      const one = (await runOperation(
        db,
        'trunks.get',
        { id: trunk.id },
        asRun()
      )) as { status: string; statusChangedAt: string | null };
      expect(one).toMatchObject(reported);
    } finally {
      vi.mocked(getCoreClient).mockReset();
    }
  });

  it('refuses an inbound-auth username that already names an endpoint (§9.4 Inbound identification)', async () => {
    const db = await makeTestDb();
    const inboundAuth = {
      inboundAuth: true,
      username: 'acct-4711',
      password: 'secret-4711'
    };
    const { trunk: holder } = await createTrunk(db, {
      name: 'Provider A',
      ...inboundAuth
    });
    await expect(
      createTrunk(db, { name: 'Provider B', ...inboundAuth })
    ).rejects.toMatchObject({
      status: 409,
      references: [{ kind: 'trunk', id: holder.id, label: 'Provider A' }]
    });
    await expect(
      createTrunk(db, {
        name: 'Provider C',
        ...inboundAuth,
        username: 'trunk-4711'
      })
    ).rejects.toMatchObject({ status: 422 });
    // The same account without `inbound_auth` names no endpoint of its own.
    await expect(
      createTrunk(db, {
        name: 'Provider D',
        authMode: 'registration',
        username: 'acct-4711',
        password: 'secret-4711'
      })
    ).resolves.toBeDefined();
  });

  it('refuses the inbound-auth username anonymous, which would define the anonymous endpoint (§5.6)', async () => {
    const db = await makeTestDb();
    await expect(
      createTrunk(db, {
        inboundAuth: true,
        username: 'anonymous',
        password: 'secret-4711'
      })
    ).rejects.toMatchObject({ status: 422 });
  });

  it('refuses a CIDR host unless its direction is inbound', async () => {
    const db = await makeTestDb();
    await expect(
      createTrunk(db, { hosts: [{ host: '10.0.0.0/8' }] })
    ).rejects.toMatchObject({ status: 422 });
    await expect(
      createTrunk(db, {
        hosts: [{ host: '10.0.0.0/8', direction: 'outbound' }]
      })
    ).rejects.toMatchObject({ status: 422 });
    await expect(
      createTrunk(db, {
        hosts: [{ host: '10.0.0.0/8', direction: 'inbound' }]
      })
    ).resolves.toBeDefined();
  });

  it('refuses a host or outboundProxy with characters the pjsip renderer refuses', async () => {
    const db = await makeTestDb();
    await expect(
      createTrunk(db, { hosts: [{ host: 'sip.example\n[evil]' }] })
    ).rejects.toMatchObject({ status: 422 });
    await expect(
      createTrunk(db, { outboundProxy: 'proxy.example\n[evil]' })
    ).rejects.toMatchObject({ status: 422 });
  });

  it('refuses a username or password with characters the pjsip renderer refuses, on create and update', async () => {
    const db = await makeTestDb();
    await expect(
      createTrunk(db, {
        authMode: 'registration',
        username: 'a\n[anonymous]',
        password: 'secret'
      })
    ).rejects.toMatchObject({ status: 422 });
    await expect(
      createTrunk(db, {
        authMode: 'registration',
        username: 'bob@evil',
        password: 'secret'
      })
    ).rejects.toMatchObject({ status: 422 });
    await expect(
      createTrunk(db, {
        authMode: 'registration',
        username: 'bob',
        password: 'sec\nret'
      })
    ).rejects.toMatchObject({ status: 422 });

    const { trunk } = await createTrunk(db, {
      name: 'Provider C',
      authMode: 'registration',
      username: 'bob',
      password: 'secret'
    });
    await expect(
      runOperation(
        db,
        'trunks.update',
        { id: trunk.id, username: 'a\n[anonymous]' },
        asRun()
      )
    ).rejects.toMatchObject({ status: 422 });
    await expect(
      runOperation(
        db,
        'trunks.update',
        { id: trunk.id, password: 'sec\nret' },
        asRun()
      )
    ).rejects.toMatchObject({ status: 422 });
  });

  it('refuses an outboundProxy without a sip: or sips: scheme', async () => {
    const db = await makeTestDb();
    await expect(
      createTrunk(db, { outboundProxy: 'sbc.provider-a.example' })
    ).rejects.toMatchObject({ status: 422 });
    await expect(
      createTrunk(db, { outboundProxy: 'sbc.provider-a.example:5060;lr' })
    ).rejects.toMatchObject({ status: 422 });
  });

  it('accepts a SIP-URI outboundProxy, with or without its loose-routing parameter', async () => {
    const db = await makeTestDb();
    await expect(
      createTrunk(db, { outboundProxy: 'sip:sbc.provider-a.example' })
    ).resolves.toBeDefined();
    await expect(
      createTrunk(db, {
        name: 'Provider B',
        outboundProxy: 'sips:sbc.provider-b.example:5061;lr'
      })
    ).resolves.toBeDefined();
  });

  it('refuses a CIDR outboundProxy: a proxy is always a dial target, never a source address', async () => {
    const db = await makeTestDb();
    await expect(
      createTrunk(db, { outboundProxy: 'sip:10.0.0.0/8' })
    ).rejects.toMatchObject({ status: 422 });
  });

  it('refuses an empty codecs array on create and update', async () => {
    const db = await makeTestDb();
    await expect(createTrunk(db, { codecs: [] })).rejects.toMatchObject({
      status: 422
    });
    const { trunk } = await createTrunk(db);
    await expect(
      runOperation(db, 'trunks.update', { id: trunk.id, codecs: [] }, asRun())
    ).rejects.toMatchObject({ status: 422 });
  });

  it('refuses registerExpiryS/registerRetryS on an ip trunk, on create and update', async () => {
    const db = await makeTestDb();
    await expect(
      createTrunk(db, { authMode: 'ip', registerExpiryS: 120 })
    ).rejects.toMatchObject({ status: 422 });
    const { trunk } = await createTrunk(db);
    await expect(
      runOperation(
        db,
        'trunks.update',
        { id: trunk.id, registerRetryS: 30 },
        asRun()
      )
    ).rejects.toMatchObject({ status: 422 });
  });

  it('refuses a username or password beginning or ending with whitespace, which Asterisk would trim, on create and update', async () => {
    const db = await makeTestDb();
    await Promise.all(
      [
        { username: ' bob', password: 'secret' },
        { username: 'bob\t', password: 'secret' },
        { username: 'bob', password: ' secret' },
        { username: 'bob', password: 'secret ' },
        { username: 'bob', password: 'secret\t' }
      ].map(credentials =>
        expect(
          createTrunk(db, { authMode: 'registration', ...credentials })
        ).rejects.toMatchObject({ status: 422 })
      )
    );

    const { trunk } = await createTrunk(db, {
      name: 'Provider D',
      authMode: 'registration',
      username: 'bob',
      password: 'inner space is fine'
    });
    await expect(
      runOperation(
        db,
        'trunks.update',
        { id: trunk.id, password: 'secret ' },
        asRun()
      )
    ).rejects.toMatchObject({ status: 422 });
    await expect(
      runOperation(
        db,
        'trunks.update',
        { id: trunk.id, username: ' bob' },
        asRun()
      )
    ).rejects.toMatchObject({ status: 422 });
  });

  it('refuses an explicit username on update for a trunk whose auth carries no credentials', async () => {
    const db = await makeTestDb();
    const { trunk } = await createTrunk(db, { authMode: 'ip' });
    await expect(
      runOperation(
        db,
        'trunks.update',
        { id: trunk.id, username: 'bob' },
        asRun()
      )
    ).rejects.toMatchObject({ status: 422 });
  });
  it('records the dropped password and stops the entry being undoable when an auth-mode switch clears it', async () => {
    const db = await makeTestDb();
    const { trunk } = await createTrunk(db, {
      authMode: 'registration',
      username: 'alice',
      password: 's3cret',
      registerExpiryS: 120
    });

    await runOperation(
      db,
      'trunks.update',
      { id: trunk.id, authMode: 'ip' },
      asRun()
    );

    const row = await db
      .selectFrom('trunks')
      .select('passwordEnc')
      .where('id', '=', trunk.id)
      .executeTakeFirstOrThrow();
    expect(row.passwordEnc).toBeNull();
    const audit = await db
      .selectFrom('auditLog')
      .select(['changesJson', 'undoable'])
      .where('operation', '=', 'trunks.update')
      .where('entityId', '=', trunk.id)
      .executeTakeFirstOrThrow();
    expect(audit.undoable).toBe(0);
    const changes = JSON.parse(audit.changesJson) as {
      field: string;
      from: unknown;
      to: unknown;
    }[];
    expect(changes).toContainEqual({
      field: 'password',
      from: '***',
      to: '***'
    });
  });

  it('keeps the entry undoable when an update leaves the stored password in place', async () => {
    const db = await makeTestDb();
    const { trunk } = await createTrunk(db, {
      authMode: 'registration',
      username: 'alice',
      password: 's3cret',
      registerExpiryS: 120
    });

    await runOperation(
      db,
      'trunks.update',
      { id: trunk.id, name: 'Provider B' },
      asRun()
    );

    const audit = await db
      .selectFrom('auditLog')
      .select('undoable')
      .where('operation', '=', 'trunks.update')
      .where('entityId', '=', trunk.id)
      .executeTakeFirstOrThrow();
    expect(audit.undoable).toBe(1);
  });
  it('never returns the password, reports passwordSet, and refuses null where credentials are required', async () => {
    const db = await makeTestDb();
    const { trunk } = await createTrunk(db, {
      authMode: 'registration',
      username: 'alice',
      password: 's3cret',
      registerExpiryS: 120
    });
    const get = async (): Promise<Record<string, unknown>> =>
      (await runOperation(
        db,
        'trunks.get',
        { id: trunk.id },
        asRun()
      )) as Record<string, unknown>;
    const read = await get();
    expect(read.passwordSet).toBe(true);
    expect(read).not.toHaveProperty('password');
    await expect(
      runOperation(
        db,
        'trunks.update',
        { id: trunk.id, password: null },
        asRun()
      )
    ).rejects.toMatchObject({ status: 422 });
    await runOperation(
      db,
      'trunks.update',
      { id: trunk.id, authMode: 'ip', username: null, password: null },
      asRun()
    );
    expect((await get()).passwordSet).toBe(false);
  });

  it('sets a diagnostics override on a trunk and gives it a 7-day expiry (§7)', async () => {
    const db = await makeTestDb();
    const { trunk } = await createTrunk(db);

    const out = (await runOperation(
      db,
      'trunks.update',
      { id: trunk.id, logLevel: 'sip' },
      asRun()
    )) as {
      trunk: { logLevel: string | null; logLevelExpiresAt: string | null };
    };

    expect(out.trunk.logLevel).toBe('sip');
    const expiresAt = Date.parse(out.trunk.logLevelExpiresAt ?? '');
    const sevenDaysMs = 7 * 86_400_000;
    expect(expiresAt - Date.now()).toBeGreaterThan(sevenDaysMs - 60_000);
    expect(expiresAt - Date.now()).toBeLessThan(sevenDaysMs + 60_000);
  });

  it("refuses the 'sip' override while HEP_ENABLED is false (§7)", async () => {
    const db = await makeTestDb();
    const { trunk } = await createTrunk(db);
    process.env.HEP_ENABLED = 'false';

    try {
      const attempt = runOperation(
        db,
        'trunks.update',
        { id: trunk.id, logLevel: 'sip' },
        asRun()
      );
      await expect(attempt).rejects.toMatchObject({ status: 422 });
    } finally {
      delete process.env.HEP_ENABLED;
    }
  });

  // §10.3 "Conventions": list endpoints paginate with `?limit=` and an opaque `?cursor=`.
  it('list pages through the trunks in trunk order with limit and cursor', async () => {
    const db = await makeTestDb();
    const first = await createTrunk(db, { name: 'Provider A' });
    const second = await createTrunk(db, { name: 'Provider B' });
    type Page = { items: { id: string }[]; nextCursor: string | null };

    const one = (await runOperation(
      db,
      'trunks.list',
      { limit: 1 },
      asRun()
    )) as Page;
    expect(one.items.map(item => item.id)).toEqual([first.trunk.id]);
    expect(one.nextCursor).toEqual(expect.any(String));

    const two = (await runOperation(
      db,
      'trunks.list',
      { limit: 1, cursor: one.nextCursor },
      asRun()
    )) as Page;
    expect(two.items.map(item => item.id)).toEqual([second.trunk.id]);
    expect(two.nextCursor).toBeNull();
  });
});
