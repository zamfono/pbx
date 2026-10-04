import { describe, expect, it } from 'vitest';

import type { Db } from '@zamfono/shared';

import { createTrunk } from '#testing/fixtures.js';
import { asRun, makeTestDb } from '#testing/testDb.js';

import { runOperation } from '../runner.js';

import './index.js';
import '../outboundRoutes/index.js';

type TrunkWire = { id: string; authMode: string; diversion: string };
type TrunkOutput = { trunk: TrunkWire; warnings: string[] };

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
    const got = (await runOperation(
      db,
      'trunks.get',
      { id: trunk.id },
      asRun()
    )) as TrunkWire;
    expect(got.diversion).toBe('all');
    const listed = (await runOperation(db, 'trunks.list', {}, asRun())) as {
      items: TrunkWire[];
    };
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
