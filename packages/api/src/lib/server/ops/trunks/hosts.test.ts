import { afterEach, describe, expect, it } from 'vitest';

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
  const originalSipUdpEnabled = process.env.SIP_UDP_ENABLED;

  afterEach(() => {
    if (originalSipUdpEnabled === undefined) {
      delete process.env.SIP_UDP_ENABLED;
    } else {
      process.env.SIP_UDP_ENABLED = originalSipUdpEnabled;
    }
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
    process.env.SIP_UDP_ENABLED = 'false';
    await expect(
      updateTrunk(db, { id: trunk.id, name: 'Renamed' })
    ).resolves.toBeDefined();
    await expect(
      updateTrunk(db, { id: trunk.id, transport: 'udp' })
    ).rejects.toMatchObject({ status: 422 });
  });
});
