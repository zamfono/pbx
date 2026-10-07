import { describe, expect, it } from 'vitest';

import type { Db } from '@zamfono/shared';

import { createTrunk } from '#testing/fixtures.js';
import { asRun, makeTestDb } from '#testing/testDb.js';

import { runOperation } from '../runner.js';

import './index.js';
import '../outboundRoutes/index.js';

type TrunkWire = { id: string; forwardedCallerId: string };
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

async function stored(db: Db, id: string): Promise<string> {
  const row = await db
    .selectFrom('trunks')
    .select('forwardedCallerId')
    .where('id', '=', id)
    .executeTakeFirstOrThrow();
  return row.forwardedCallerId;
}

const CLIP_NO_SCREENING = { diversion: 'last', forwardedCallerId: 'original' };

// §9.4 "Forwarded calls", §10.3 Trunks, §11.2 `trunks.forwarded_caller_id`.
describe('trunk forwardedCallerId setting', () => {
  it('a new trunk presents its own number unless told otherwise', async () => {
    const db = await makeTestDb();
    const { trunk } = await createTrunk(db, {});
    expect(trunk.forwardedCallerId).toBe('own');
    expect(await stored(db, trunk.id)).toBe('own');
  });

  it('stores original and originalPreferred on a from trunk with Diversion, and reads them back', async () => {
    const db = await makeTestDb();
    const { trunk } = await createTrunk(db, CLIP_NO_SCREENING);
    expect(trunk.forwardedCallerId).toBe('original');
    const { trunk: second } = await createTrunk(db, {
      name: 'Provider B',
      diversion: 'all',
      forwardedCallerId: 'originalPreferred'
    });
    expect(await stored(db, second.id)).toBe('originalPreferred');
    const got = (await runOperation(
      db,
      'trunks.get',
      { id: second.id },
      asRun()
    )) as TrunkWire;
    expect(got.forwardedCallerId).toBe('originalPreferred');
    const updated = await updateTrunk(db, trunk.id, {
      forwardedCallerId: 'own'
    });
    expect(updated.forwardedCallerId).toBe('own');
  });

  it('refuses a value outside the three', async () => {
    const db = await makeTestDb();
    await expect(
      createTrunk(db, { diversion: 'last', forwardedCallerId: 'spoofed' })
    ).rejects.toMatchObject({ status: 422 });
  });

  it('refuses the original caller without Diversion, or on a trunk that is not from', async () => {
    const db = await makeTestDb();
    await expect(
      createTrunk(db, { forwardedCallerId: 'original' })
    ).rejects.toThrow(/requires diversion 'last' or 'all'/u);
    await Promise.all(
      ['pai', 'both'].map(callerIdHeader =>
        expect(
          createTrunk(db, {
            ...CLIP_NO_SCREENING,
            callerIdHeader,
            username: 'acct'
          })
        ).rejects.toThrow(/requires callerIdHeader 'from'/u)
      )
    );
  });

  it('refuses an update that leaves the original caller without Diversion or from', async () => {
    const db = await makeTestDb();
    const { trunk } = await createTrunk(db, {});
    await expect(
      updateTrunk(db, trunk.id, { forwardedCallerId: 'originalPreferred' })
    ).rejects.toMatchObject({ status: 422 });
    await updateTrunk(db, trunk.id, CLIP_NO_SCREENING);
    await expect(
      updateTrunk(db, trunk.id, { diversion: 'off' })
    ).rejects.toMatchObject({ status: 422 });
    await expect(
      updateTrunk(db, trunk.id, { callerIdHeader: 'both' })
    ).rejects.toMatchObject({ status: 422 });
    expect(await stored(db, trunk.id)).toBe('original');
    const own = await updateTrunk(db, trunk.id, {
      forwardedCallerId: 'own',
      diversion: 'off',
      callerIdHeader: 'both'
    });
    expect(own.forwardedCallerId).toBe('own');
  });
});
