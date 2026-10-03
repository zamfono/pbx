import { describe, expect, it } from 'vitest';

import type { Db } from '@zamfono/shared';

import { asRun, makeTestDb } from '#lib/server/testDb.js';

import { runOperation } from '../runner.js';

import './index.js';
import '../outboundRoutes/index.js';

type TrunkWire = { id: string; authMode: string; qualify: boolean };
type TrunkOutput = { trunk: TrunkWire; warnings: string[] };

async function createTrunk(
  db: Db,
  fields: Record<string, unknown>
): Promise<TrunkOutput> {
  return runOperation(
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
  ) as Promise<TrunkOutput>;
}

async function updateTrunk(
  db: Db,
  id: string,
  fields: Record<string, unknown>
): Promise<TrunkWire> {
  const { trunk } = (await runOperation(
    db,
    'trunks.update',
    { id, ...fields },
    asRun()
  )) as TrunkOutput;
  return trunk;
}

async function storedQualify(db: Db, id: string): Promise<number> {
  const row = await db
    .selectFrom('trunks')
    .select('qualify')
    .where('id', '=', id)
    .executeTakeFirstOrThrow();
  return row.qualify;
}

// §9.4 "Provisioning and status", §10.3 Trunks, §11.2 `trunks.qualify`.
describe('trunk qualify setting', () => {
  it('a new trunk is probed unless told otherwise', async () => {
    const db = await makeTestDb();
    const { trunk } = await createTrunk(db, {});
    expect(trunk.qualify).toBe(true);
    expect(await storedQualify(db, trunk.id)).toBe(1);
  });

  it('stores qualify false as given and reads it back on get and list', async () => {
    const db = await makeTestDb();
    const { trunk } = await createTrunk(db, { qualify: false });
    expect(trunk.qualify).toBe(false);
    expect(await storedQualify(db, trunk.id)).toBe(0);
    const got = (await runOperation(
      db,
      'trunks.get',
      { id: trunk.id },
      asRun()
    )) as TrunkWire;
    expect(got.qualify).toBe(false);
    const listed = (await runOperation(db, 'trunks.list', {}, asRun())) as {
      items: TrunkWire[];
    };
    expect(listed.items.map(row => row.qualify)).toEqual([false]);
  });

  it('refuses a qualify that is not a boolean', async () => {
    const db = await makeTestDb();
    await expect(createTrunk(db, { qualify: 0 })).rejects.toMatchObject({
      status: 422
    });
  });

  it('keeps qualify across other updates and updates it alone', async () => {
    const db = await makeTestDb();
    const { trunk } = await createTrunk(db, { qualify: false });
    const renamed = await updateTrunk(db, trunk.id, { name: 'Provider B' });
    expect(renamed.qualify).toBe(false);
    const probed = await updateTrunk(db, trunk.id, { qualify: true });
    expect(probed.qualify).toBe(true);
    expect(await storedQualify(db, trunk.id)).toBe(1);
  });

  it('accepts and keeps qualify on a registration trunk without a warning', async () => {
    const db = await makeTestDb();
    const { trunk, warnings } = await createTrunk(db, {
      authMode: 'registration',
      username: 'acct',
      password: 'secret',
      qualify: false
    });
    expect(trunk).toMatchObject({ authMode: 'registration', qualify: false });
    expect(warnings.filter(warning => warning.includes('qualify'))).toEqual([]);
  });

  it('records a changed qualify in the audit entry', async () => {
    const db = await makeTestDb();
    const { trunk } = await createTrunk(db, {});
    await updateTrunk(db, trunk.id, { qualify: false });
    const entry = await db
      .selectFrom('auditLog')
      .select('changesJson')
      .where('operation', '=', 'trunks.update')
      .executeTakeFirstOrThrow();
    expect(JSON.parse(entry.changesJson)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ field: 'qualify', from: true, to: false })
      ])
    );
  });
});
