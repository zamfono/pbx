import { describe, expect, it } from 'vitest';

import type { Db } from '@zamfono/shared';

import { makeTestDb } from '$lib/server/testDb.js';

import { runOperation } from '../runner.js';
import type { Actor } from '../types.js';

import './index.js';
import '../outboundRoutes/index.js';

process.env.SECRETBOX_KEY ??= `1:${Buffer.alloc(32, 7).toString('base64')}`;

const owner: Actor = { id: 'owner', name: 'Owner', role: 'owner' };

function asRun(): { actor: Actor; channel: 'rest'; requestId: string } {
  return { actor: owner, channel: 'rest', requestId: 'req-1' };
}

type TrunkWire = {
  id: string;
  transport: string;
  srtp: boolean;
  tlsVerify: boolean;
};
type TrunkOutput = { trunk: TrunkWire };

async function createTrunk(
  db: Db,
  fields: Record<string, unknown>
): Promise<TrunkWire> {
  const { trunk } = await runOperation<unknown, TrunkOutput>(
    db,
    'trunks.create',
    {
      name: 'Provider A',
      emergency: true,
      authMode: 'ip',
      hosts: [{ host: 'sip.provider.example' }],
      ...fields
    },
    asRun()
  );
  return trunk;
}

async function updateTrunk(
  db: Db,
  id: string,
  fields: Record<string, unknown>
): Promise<TrunkWire> {
  const { trunk } = await runOperation<unknown, TrunkOutput>(
    db,
    'trunks.update',
    { id, ...fields },
    asRun()
  );
  return trunk;
}

// §9.4 "Signaling", §11.2 `trunks.srtp` and `trunks.tls_verify`.
describe('trunk TLS and SRTP settings', () => {
  it('a new trunk checks its certificate and sends plain RTP unless told otherwise', async () => {
    const db = await makeTestDb();
    const trunk = await createTrunk(db, { transport: 'tls' });
    expect(trunk).toMatchObject({ srtp: false, tlsVerify: true });
  });

  it('stores srtp and tlsVerify as given on a tls trunk', async () => {
    const db = await makeTestDb();
    const trunk = await createTrunk(db, {
      transport: 'tls',
      srtp: true,
      tlsVerify: false
    });
    expect(trunk).toMatchObject({ srtp: true, tlsVerify: false });
    const row = await db
      .selectFrom('trunks')
      .select(['srtp', 'tlsVerify'])
      .where('id', '=', trunk.id)
      .executeTakeFirstOrThrow();
    expect(row).toEqual({ srtp: 1, tlsVerify: 0 });
  });

  it('refuses srtp on a trunk whose transport is not tls', async () => {
    const db = await makeTestDb();
    await expect(
      createTrunk(db, { transport: 'tcp', srtp: true })
    ).rejects.toMatchObject({ status: 422 });
    await expect(createTrunk(db, { srtp: true })).rejects.toMatchObject({
      status: 422
    });
  });

  it('refuses switching an srtp trunk off tls unless srtp goes with it', async () => {
    const db = await makeTestDb();
    const trunk = await createTrunk(db, { transport: 'tls', srtp: true });
    await expect(
      updateTrunk(db, trunk.id, { transport: 'tcp' })
    ).rejects.toMatchObject({ status: 422 });
    const updated = await updateTrunk(db, trunk.id, {
      transport: 'tcp',
      srtp: false
    });
    expect(updated).toMatchObject({ transport: 'tcp', srtp: false });
  });

  it('keeps tlsVerify across a transport change and updates it alone', async () => {
    const db = await makeTestDb();
    const trunk = await createTrunk(db, {
      transport: 'tls',
      tlsVerify: false
    });
    const onTcp = await updateTrunk(db, trunk.id, { transport: 'tcp' });
    expect(onTcp.tlsVerify).toBe(false);
    const verified = await updateTrunk(db, trunk.id, {
      transport: 'tls',
      tlsVerify: true
    });
    expect(verified).toMatchObject({ transport: 'tls', tlsVerify: true });
  });

  it('records a changed srtp and tlsVerify in the audit entry', async () => {
    const db = await makeTestDb();
    const trunk = await createTrunk(db, { transport: 'tls' });
    await updateTrunk(db, trunk.id, { srtp: true, tlsVerify: false });
    const entry = await db
      .selectFrom('auditLog')
      .select('changesJson')
      .where('operation', '=', 'trunks.update')
      .executeTakeFirstOrThrow();
    expect(JSON.parse(entry.changesJson)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ field: 'srtp', from: false, to: true }),
        expect.objectContaining({ field: 'tlsVerify', from: true, to: false })
      ])
    );
  });
});
