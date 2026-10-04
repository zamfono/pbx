import { beforeAll, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import {
  HTTP_FORBIDDEN,
  HTTP_OK,
  type Db,
  type StateResponse
} from '@zamfono/shared';
import { seedSettings } from '@zamfono/shared/testDb.js';

import { getCoreClient } from '#lib/server/coreClient.js';
import { stubCoreClient } from '#testing/coreClientStub.js';
import {
  INPUTS,
  liveCall,
  seedRows,
  type Rows,
  type Who
} from '#testing/ownScopeKit.js';
import { makeTestDb } from '#testing/testDb.js';

import { registry } from './registry.js';
import { runOperation } from './runner.js';
import { OpError, type Actor } from './types.js';

import './index.js';

// §5.3 own scope, cell by cell: a `user` reaches every own-scoped operation on what is their
// own and gets 403 on what is someone else's, judged by the row the input names; an `admin`
// reaches both. `run` is stubbed: the scope gate runs before it (§10.3 "Operations layer").

const REACHED = { reached: true };

const ownScoped = [...registry.values()].filter(
  op => op.minRole === 'user' && op.scope !== 'any'
);

let db: Db;
let rows: Rows;

beforeAll(async () => {
  db = await makeTestDb();
  await seedSettings(db);
  rows = await seedRows(db);
  const { own, other } = rows.user;
  const state = {
    calls: [liveCall('live-own', own), liveCall('live-other', other)]
  } as StateResponse;
  vi.mocked(getCoreClient).mockReturnValue(
    stubCoreClient({ state: () => Promise.resolve(state) })
  );
  for (const op of ownScoped) {
    registry.set(op.name, {
      ...op,
      output: z.unknown(),
      confirm: undefined,
      readOnly: true,
      run: () => Promise.resolve(REACHED)
    });
  }
});

/** 200 when `actor`'s call reaches `run`, else the problem status it is refused with. */
async function status(actor: Actor, name: string, input: unknown) {
  try {
    await runOperation(db, name, input, {
      actor,
      channel: 'rest',
      requestId: 'req-1'
    });
    return HTTP_OK;
  } catch (error) {
    if (error instanceof OpError) {
      return error.status;
    }
    throw error;
  }
}

describe('own scope (§5.3)', () => {
  it('has a case for every own-scoped operation', () => {
    expect(ownScoped.map(op => op.name).sort()).toEqual(
      Object.keys(INPUTS).sort()
    );
  });

  it.each(Object.keys(INPUTS))('%s', async name => {
    const user: Actor = { id: rows.user.own, name: 'Anna', role: 'user' };
    const admin: Actor = { id: 'owner', name: 'Owner', role: 'admin' };
    const input = INPUTS[name] as (rows: Rows, who: Who) => unknown;
    expect({
      own: await status(user, name, input(rows, 'own')),
      other: await status(user, name, input(rows, 'other')),
      adminOther: await status(admin, name, input(rows, 'other'))
    }).toEqual({ own: HTTP_OK, other: HTTP_FORBIDDEN, adminOther: HTTP_OK });
  });

  it.each([
    'devices.delete',
    'devices.getBlf',
    'devices.setBlf',
    'devices.update'
  ])("%s refuses a user's own plain device (§10.3 Devices)", async name => {
    const user: Actor = { id: rows.user.own, name: 'Anna', role: 'user' };
    const input = { ...INPUTS[name]?.(rows, 'own'), id: rows.plainDevice.own };
    expect(await status(user, name, input)).toBe(HTTP_FORBIDDEN);
  });
});
