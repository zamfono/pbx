import { afterEach, describe, expect, it, vi } from 'vitest';

import { getCoreClient } from '#lib/server/coreClient.js';
import { stubCoreClient } from '#testing/coreClientStub.js';
import { createTrunk } from '#testing/fixtures.js';
import { asRun, makeTestDb } from '#testing/testDb.js';

import { runOperation } from '../runner.js';
import { OpError } from '../types.js';

import './index.js';

// §9.4 "Provisioning and status", §10.3 Trunks: `trunks.reregister`.
describe('trunks.reregister', () => {
  afterEach(() => {
    vi.mocked(getCoreClient).mockReset();
  });

  it('has core register a registration trunk afresh, audited as a pure action that is not undoable', async () => {
    const db = await makeTestDb();
    const { trunk } = await createTrunk(db, {
      authMode: 'registration',
      username: 'alice',
      password: 's3cret'
    });
    const reregistered: string[] = [];
    vi.mocked(getCoreClient).mockReturnValue(
      stubCoreClient({
        reregisterTrunk: trunkId => {
          reregistered.push(trunkId);
          return Promise.resolve();
        }
      })
    );

    await expect(
      runOperation(db, 'trunks.reregister', { id: trunk.id }, asRun())
    ).resolves.toEqual({ id: trunk.id });

    expect(reregistered).toEqual([trunk.id]);
    const audit = await db
      .selectFrom('auditLog')
      .selectAll()
      .where('operation', '=', 'trunks.reregister')
      .executeTakeFirstOrThrow();
    expect(audit).toMatchObject({
      entityKind: 'trunk',
      entityId: trunk.id,
      undoable: 0
    });
  });

  it('refuses an ip trunk with 409 and an unknown one with 404, without asking core', async () => {
    const db = await makeTestDb();
    const { trunk } = await createTrunk(db);
    const reregisterTrunk = vi.fn(() => Promise.resolve());
    vi.mocked(getCoreClient).mockReturnValue(
      stubCoreClient({ reregisterTrunk })
    );

    await expect(
      runOperation(db, 'trunks.reregister', { id: trunk.id }, asRun())
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      runOperation(db, 'trunks.reregister', { id: 'no-such-trunk' }, asRun())
    ).rejects.toMatchObject({ status: 404 });
    expect(reregisterTrunk).not.toHaveBeenCalled();
  });

  it("answers core's refusal with its status and reason, and core not answering with 503", async () => {
    const db = await makeTestDb();
    const { trunk } = await createTrunk(db, {
      authMode: 'registration',
      username: 'alice',
      password: 's3cret'
    });
    vi.mocked(getCoreClient).mockReturnValue(
      stubCoreClient({
        reregisterTrunk: () =>
          Promise.reject(
            new OpError(409, 'trunk has no registration', 'noRegistration')
          )
      })
    );
    await expect(
      runOperation(db, 'trunks.reregister', { id: trunk.id }, asRun())
    ).rejects.toMatchObject({ status: 409 });

    vi.mocked(getCoreClient).mockReturnValue(stubCoreClient());
    await expect(
      runOperation(db, 'trunks.reregister', { id: trunk.id }, asRun())
    ).rejects.toMatchObject({ status: 503 });
  });
});
