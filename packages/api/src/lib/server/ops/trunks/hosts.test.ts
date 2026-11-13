import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Db } from '@zamfono/shared';

import { createTrunk } from '#testing/fixtures.js';
import { asRun, makeTestDb } from '#testing/testDb.js';

import { runOperation } from '../runner.js';

import '../outboundRoutes/index.js';
import './index.js';

async function updateTrunk(
  db: Db,
  input: Record<string, unknown>
): Promise<unknown> {
  return runOperation(db, 'trunks.update', input, asRun());
}

const REGISTRATION = {
  authMode: 'registration',
  username: 'alice',
  password: 's3cret'
};

const INBOUND_ONLY = [{ host: '192.0.2.10', direction: 'inbound' }];

describe('trunk hosts and transport (§9.4 "Hosts", "Signaling")', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('refuses a registration trunk with no outbound or both host, on create and update', async () => {
    const db = await makeTestDb();
    await expect(
      createTrunk(db, { ...REGISTRATION, hosts: INBOUND_ONLY })
    ).rejects.toMatchObject({ status: 422, message: /registrar/u });
    const { trunk } = await createTrunk(db, REGISTRATION);
    await expect(
      updateTrunk(db, { id: trunk.id, hosts: INBOUND_ONLY })
    ).rejects.toMatchObject({ status: 422, message: /registrar/u });
    const { trunk: ipTrunk } = await createTrunk(db, {
      name: 'Provider B',
      hosts: INBOUND_ONLY
    });
    await expect(
      updateTrunk(db, { id: ipTrunk.id, ...REGISTRATION })
    ).rejects.toMatchObject({ status: 422, message: /registrar/u });
  });

  // §5.4: the stored password must not follow the trunk to a registrar or proxy it was not given for.
  it('needs the password again for a new outbound host or outboundProxy, not for other fields', async () => {
    const db = await makeTestDb();
    const { trunk } = await createTrunk(db, {
      ...REGISTRATION,
      hosts: [{ host: 'sip.provider.example', port: 5060 }, ...INBOUND_ONLY]
    });
    const update = (input: Record<string, unknown>): Promise<unknown> =>
      updateTrunk(db, { id: trunk.id, ...input });
    const refused = { status: 422, message: /password again/u };
    const registrar = { host: 'sip.provider.example', port: 5060 };
    const moved = [
      [{ host: 'evil.example.net' }],
      [{ ...registrar, port: 5080 }],
      [{ host: 'sip.provider.example' }],
      [registrar, { host: 'evil.example.net', direction: 'outbound' }],
      [registrar, { host: '192.0.2.10', direction: 'both' }]
    ];
    await Promise.all(
      moved.map(hosts =>
        expect(update({ hosts }), JSON.stringify(hosts)).rejects.toMatchObject(
          refused
        )
      )
    );
    await expect(
      update({ outboundProxy: 'sip:proxy.evil.example' })
    ).rejects.toMatchObject(refused);
    // Reordering, an inbound-only host, dropping a host and every other field keep it.
    await update({
      hosts: [...INBOUND_ONLY, { ...registrar, direction: 'outbound' }]
    });
    await update({
      hosts: [registrar, { host: '192.0.2.99', direction: 'inbound' }]
    });
    await update({
      name: 'Renamed',
      transport: 'tcp',
      tlsVerify: false,
      username: 'bob',
      maxChannels: 4
    });
    await update({
      hosts: [{ host: 'sip2.provider.example' }],
      outboundProxy: 'sip:proxy.provider.example',
      password: 'n3w'
    });
    await update({ outboundProxy: null });
    await update({ hosts: [{ host: 'sip2.provider.example' }] });
    // No password stored: nothing to follow.
    const { trunk: ipTrunk } = await createTrunk(db, { name: 'Provider B' });
    await expect(
      updateTrunk(db, {
        id: ipTrunk.id,
        hosts: [{ host: 'other.provider.example' }],
        outboundProxy: 'sip:proxy.provider.example'
      })
    ).resolves.toBeDefined();
  });

  it('refuses an IPv6 literal as an outbound or both host, and keeps it for inbound', async () => {
    const db = await makeTestDb();
    await expect(
      createTrunk(db, { hosts: [{ host: '2001:db8::1' }] })
    ).rejects.toMatchObject({ status: 422 });
    await expect(
      createTrunk(db, {
        hosts: [{ host: '2001:db8::1', direction: 'outbound' }]
      })
    ).rejects.toMatchObject({ status: 422 });
    await expect(
      createTrunk(db, {
        hosts: [
          { host: 'sip.provider.example', direction: 'outbound' },
          { host: '2001:db8::1', direction: 'inbound' }
        ]
      })
    ).resolves.toBeDefined();
  });

  it('lets a trunk on a since-disabled transport be edited, and refuses switching to it', async () => {
    const db = await makeTestDb();
    const { trunk } = await createTrunk(db, { transport: 'udp' });
    vi.stubEnv('SIP_UDP_ENABLED', 'false');
    await expect(
      updateTrunk(db, { id: trunk.id, name: 'Renamed' })
    ).resolves.toBeDefined();
    await expect(
      updateTrunk(db, { id: trunk.id, transport: 'udp' })
    ).rejects.toMatchObject({ status: 422 });
  });
});
