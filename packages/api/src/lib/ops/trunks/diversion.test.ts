import { describe, expect, it } from 'vitest';

import type { Db } from '@zamfono/shared';

import { makeTestDb } from '#lib/testDb.js';

import { runOperation } from '../runner.js';
import type { Actor } from '../types.js';

import './index.js';
import '../outboundRoutes/index.js';

process.env.SECRETBOX_KEY ??= `1:${Buffer.alloc(32, 7).toString('base64')}`;

const owner: Actor = { id: 'owner', name: 'Owner', role: 'owner' };

function asRun(): { actor: Actor; channel: 'rest'; requestId: string } {
  return { actor: owner, channel: 'rest', requestId: 'req-1' };
}

type TrunkWire = { id: string; authMode: string; diversion: string };
type TrunkOutput = { trunk: TrunkWire; warnings: string[] };

async function createTrunk(
  db: Db,
  fields: Record<string, unknown>
): Promise<TrunkOutput> {
  return runOperation<unknown, TrunkOutput>(
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

async function storedDiversion(db: Db, id: string): Promise<string> {
  const row = await db
    .selectFrom('trunks')
    .select('diversion')
    .where('id', '=', id)
    .executeTakeFirstOrThrow();
  return row.diversion;
}

// §9.4 "Forwarded calls", §10.3 Trunks, §11.2 `trunks.diversion`.
describe('trunk diversion setting', () => {
  it('a new trunk sends no Diversion unless told otherwise', async () => {
    const db = await makeTestDb();
    const { trunk } = await createTrunk(db, {});
    expect(trunk.diversion).toBe('off');
    expect(await storedDiversion(db, trunk.id)).toBe('off');
  });

  it('stores each policy as given and reads it back on get and list', async () => {
    const db = await makeTestDb();
    const { trunk } = await createTrunk(db, { diversion: 'all' });
    expect(trunk.diversion).toBe('all');
    const { trunk: second } = await createTrunk(db, {
      name: 'Provider B',
      diversion: 'last'
    });
    expect(await storedDiversion(db, second.id)).toBe('last');
    const got = await runOperation<unknown, TrunkWire>(
      db,
      'trunks.get',
      { id: trunk.id },
      asRun()
    );
    expect(got.diversion).toBe('all');
    const listed = await runOperation<unknown, { items: TrunkWire[] }>(
      db,
      'trunks.list',
      {},
      asRun()
    );
    expect(listed.items.map(row => row.diversion)).toEqual(['all', 'last']);
  });

  it('refuses a policy outside off, last and all', async () => {
    const db = await makeTestDb();
    await Promise.all(
      ['first', true, null].map(diversion =>
        expect(createTrunk(db, { diversion })).rejects.toMatchObject({
          status: 422
        })
      )
    );
    const { trunk } = await createTrunk(db, {});
    await expect(
      updateTrunk(db, trunk.id, { diversion: 'every' })
    ).rejects.toMatchObject({ status: 422 });
  });

  it('keeps diversion across other updates and updates it alone', async () => {
    const db = await makeTestDb();
    const { trunk } = await createTrunk(db, { diversion: 'last' });
    const renamed = await updateTrunk(db, trunk.id, { name: 'Provider B' });
    expect(renamed.diversion).toBe('last');
    const off = await updateTrunk(db, trunk.id, { diversion: 'off' });
    expect(off.diversion).toBe('off');
    expect(await storedDiversion(db, trunk.id)).toBe('off');
  });

  it('records a changed diversion in the audit entry', async () => {
    const db = await makeTestDb();
    const { trunk } = await createTrunk(db, {});
    await updateTrunk(db, trunk.id, { diversion: 'all' });
    const entry = await db
      .selectFrom('auditLog')
      .select('changesJson')
      .where('operation', '=', 'trunks.update')
      .executeTakeFirstOrThrow();
    expect(JSON.parse(entry.changesJson)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ field: 'diversion', from: 'off', to: 'all' })
      ])
    );
  });
});
