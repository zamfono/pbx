import { describe, expect, it } from 'vitest';

import type { Db } from '@zamfono/shared';

import { createTrunk } from '#testing/fixtures.js';
import { asRun, makeTestDb } from '#testing/testDb.js';

import { runOperation } from '../runner.js';

import './index.js';
import '../outboundRoutes/index.js';

const NO_EMERGENCY_TRUNK = 'no emergency trunk; emergency calls will fail';

type TrunkOutput = {
  trunk: { id: string; emergency: boolean };
  warnings: string[];
};

async function updateTrunk(
  db: Db,
  id: string,
  emergency: boolean
): Promise<TrunkOutput> {
  return runOperation(
    db,
    'trunks.update',
    { id, emergency },
    asRun()
  ) as Promise<TrunkOutput>;
}

/** Deletes `id` after dropping the outbound routes that name it, which would refuse the delete. */
async function deleteTrunk(
  db: Db,
  id: string
): Promise<{ warnings: string[] }> {
  await db.deleteFrom('outboundRoutes').where('trunkId', '=', id).execute();
  return runOperation(
    db,
    'trunks.delete',
    { id },
    { ...asRun(), confirm: true }
  ) as Promise<{ warnings: string[] }>;
}

describe('emergency trunks (§9.4 "Emergency trunks")', () => {
  it('refuses a trunks.create without emergency with 422', async () => {
    const db = await makeTestDb();
    await expect(
      runOperation(
        db,
        'trunks.create',
        {
          name: 'Provider A',
          authMode: 'ip',
          hosts: [{ host: 'sip.provider.example' }]
        },
        asRun()
      )
    ).rejects.toMatchObject({ status: 422 });
  });

  it('stores the flag and returns it on create, get and update', async () => {
    const db = await makeTestDb();
    const { trunk } = await createTrunk(db, {
      name: 'local',
      emergency: true,
      hosts: [{ host: 'local.provider.example' }]
    });
    expect(trunk.emergency).toBe(true);
    const updated = await updateTrunk(db, trunk.id, false);
    expect(updated.trunk.emergency).toBe(false);
    const got = (await runOperation(
      db,
      'trunks.get',
      { id: trunk.id },
      asRun()
    )) as { emergency: boolean };
    expect(got.emergency).toBe(false);
  });

  it('warns on a create that leaves no trunk flagged, and not once one is', async () => {
    const db = await makeTestDb();
    const foreign = await createTrunk(db, {
      name: 'foreign',
      emergency: false,
      hosts: [{ host: 'foreign.provider.example' }]
    });
    expect(foreign.warnings).toEqual([NO_EMERGENCY_TRUNK]);
    const local = await createTrunk(db, {
      name: 'local',
      emergency: true,
      hosts: [{ host: 'local.provider.example' }]
    });
    expect(local.warnings).toEqual([]);
    const other = await createTrunk(db, {
      name: 'other',
      emergency: false,
      hosts: [{ host: 'other.provider.example' }]
    });
    expect(other.warnings).toEqual([]);
  });

  it('warns on an update that clears the last flag', async () => {
    const db = await makeTestDb();
    const { trunk } = await createTrunk(db, {
      name: 'local',
      emergency: true,
      hosts: [{ host: 'local.provider.example' }]
    });
    const cleared = await updateTrunk(db, trunk.id, false);
    expect(cleared.warnings).toEqual([NO_EMERGENCY_TRUNK]);
    const restored = await updateTrunk(db, trunk.id, true);
    expect(restored.warnings).toEqual([]);
  });

  it('warns on a delete that removes the last flagged trunk', async () => {
    const db = await makeTestDb();
    const local = await createTrunk(db, {
      name: 'local',
      emergency: true,
      hosts: [{ host: 'local.provider.example' }]
    });
    const foreign = await createTrunk(db, {
      name: 'foreign',
      emergency: false,
      hosts: [{ host: 'foreign.provider.example' }]
    });
    expect((await deleteTrunk(db, foreign.trunk.id)).warnings).toEqual([]);
    expect((await deleteTrunk(db, local.trunk.id)).warnings).toEqual([
      NO_EMERGENCY_TRUNK
    ]);
  });

  it('records a changed flag in the audit diff (§5.8)', async () => {
    const db = await makeTestDb();
    const { trunk } = await createTrunk(db, {
      name: 'local',
      emergency: true,
      hosts: [{ host: 'local.provider.example' }]
    });
    await updateTrunk(db, trunk.id, false);
    const entry = await db
      .selectFrom('auditLog')
      .select('changesJson')
      .where('operation', '=', 'trunks.update')
      .executeTakeFirstOrThrow();
    expect(JSON.parse(entry.changesJson)).toContainEqual({
      field: 'emergency',
      from: true,
      to: false
    });
  });
});
