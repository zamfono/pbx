import { describe, expect, it, vi } from 'vitest';

import {
  MS_PER_HOUR,
  MS_PER_MINUTE,
  newId,
  type CoreVersionResponse,
  type Db
} from '@zamfono/shared';

import type { ProvisioningProvider } from '../provisioning/index.js';
import { makeTestDb } from '../testDb.js';
import {
  checkAsteriskRestart,
  watchAsteriskRestarts,
  type ReregState
} from './ringotelRereg.js';

/** `minutes` from now, as the ISO time an audit entry or an Asterisk start carries. */
function at(minutes: number): string {
  return new Date(Date.now() + minutes * MS_PER_MINUTE).toISOString();
}

// Every entry this suite's checks write is dated now: an Asterisk start before it is an old one.
const STARTED = at(-60);
const RESTARTED = at(-10);

function core(
  asteriskStartedAt: string | null
): () => Promise<CoreVersionResponse> {
  return () =>
    Promise.resolve({
      version: 'dev',
      revision: '',
      display: 'dev',
      startedAt: '2026-09-29T07:59:58.000Z',
      asteriskStartedAt
    });
}

function ringotel(onPbxRestarted: () => Promise<void>): {
  provider: () => Promise<ProvisioningProvider>;
} {
  return {
    provider: () =>
      Promise.resolve({
        onDeviceCreated: () => Promise.resolve(null),
        onDeviceDeleted: () => Promise.resolve(),
        onCredentialsRotated: () => Promise.resolve(null),
        onPbxRestarted
      })
  };
}

async function auditRow(db: Db, operation: string, createdAt: string) {
  await db
    .insertInto('auditLog')
    .values({
      id: newId(),
      actorUserId: 'owner',
      actorUserName: 'Owner',
      channel: 'mcp',
      operation,
      entityKind: 'settings',
      entityId: 'settings',
      changesJson: '[]',
      createdAt
    })
    .execute();
}

async function reregRows(db: Db) {
  return db
    .selectFrom('auditLog')
    .selectAll()
    .where('operation', '=', 'ringotel.rereg')
    .execute();
}

describe('checkAsteriskRestart (§10.4 "After a restart")', () => {
  it('re-registers once per Asterisk start, and audits it as a job', async () => {
    const db = await makeTestDb();
    await auditRow(db, 'provisioning.ringotelSetup', at(-120));
    const rereg = vi.fn(() => Promise.resolve());
    const state: ReregState = { lastSeen: null };
    const deps = { db, lookup: core(STARTED), ...ringotel(rereg) };

    await checkAsteriskRestart(deps, state);
    await checkAsteriskRestart(deps, state);

    expect(rereg).toHaveBeenCalledOnce();
    const rows = await reregRows(db);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      channel: 'job',
      actorUserId: 'system',
      undoable: 0
    });
    expect(JSON.parse(rows[0]?.changesJson ?? '')).toEqual([
      { field: 'outcome', from: null, to: 'reregistered' },
      { field: 'asteriskStartedAt', from: null, to: STARTED }
    ]);
  });

  it('sends nothing again after an api restart that saw the same Asterisk', async () => {
    const db = await makeTestDb();
    const rereg = vi.fn(() => Promise.resolve());
    await checkAsteriskRestart(
      { db, lookup: core(STARTED), ...ringotel(rereg) },
      { lastSeen: null }
    );

    // A fresh process: nothing in memory, the audit entry is what remembers.
    await checkAsteriskRestart(
      { db, lookup: core(STARTED), ...ringotel(rereg) },
      { lastSeen: null }
    );

    expect(rereg).toHaveBeenCalledOnce();
  });

  it('re-registers again for the next Asterisk start', async () => {
    const db = await makeTestDb();
    const rereg = vi.fn(() => Promise.resolve());
    const state: ReregState = { lastSeen: null };
    await checkAsteriskRestart(
      { db, lookup: core(STARTED), ...ringotel(rereg) },
      state
    );
    // The first entry is dated now; the next start has to be later than it.
    const later = at(1);

    await checkAsteriskRestart(
      { db, lookup: core(later), ...ringotel(rereg) },
      state
    );

    expect(rereg).toHaveBeenCalledTimes(2);
  });

  it('sends nothing for an Asterisk that ran before Ringotel was set up', async () => {
    const db = await makeTestDb();
    await auditRow(db, 'provisioning.ringotelAdopt', at(-30));
    const rereg = vi.fn(() => Promise.resolve());

    await checkAsteriskRestart(
      { db, lookup: core(STARTED), ...ringotel(rereg) },
      { lastSeen: null }
    );

    expect(rereg).not.toHaveBeenCalled();
    await checkAsteriskRestart(
      { db, lookup: core(RESTARTED), ...ringotel(rereg) },
      { lastSeen: null }
    );
    expect(rereg).toHaveBeenCalledOnce();
  });

  it('sends nothing while Ringotel is not set up, or core does not say', async () => {
    const db = await makeTestDb();
    const state: ReregState = { lastSeen: null };

    await checkAsteriskRestart(
      { db, lookup: core(STARTED), provider: () => Promise.resolve(null) },
      state
    );
    await checkAsteriskRestart(
      {
        db,
        lookup: () => Promise.reject(new Error('ECONNREFUSED')),
        provider: () => Promise.reject(new Error('unused'))
      },
      { lastSeen: null }
    );
    await checkAsteriskRestart(
      {
        db,
        lookup: core(null),
        provider: () => Promise.reject(new Error('unused'))
      },
      { lastSeen: null }
    );

    expect(await reregRows(db)).toEqual([]);
  });

  it('audits a refusal without throwing, and does not retry it', async () => {
    const db = await makeTestDb();
    const rereg = vi.fn(() => Promise.reject(new Error('ringotel: down')));
    const state: ReregState = { lastSeen: null };
    const deps = { db, lookup: core(STARTED), ...ringotel(rereg) };

    await checkAsteriskRestart(deps, state);
    await checkAsteriskRestart(deps, { lastSeen: null });

    expect(rereg).toHaveBeenCalledOnce();
    const rows = await reregRows(db);
    expect(JSON.parse(rows[0]?.changesJson ?? '')).toEqual([
      { field: 'outcome', from: null, to: 'refused' },
      { field: 'reason', from: null, to: 'ringotel: down' },
      { field: 'asteriskStartedAt', from: null, to: STARTED }
    ]);
  });
});

describe('watchAsteriskRestarts (§10.4 "After a restart")', () => {
  it('asks core once per stream connection, and never on its own', async () => {
    const db = await makeTestDb();
    vi.useFakeTimers();
    try {
      const lookup = vi.fn(core(STARTED));
      const rereg = vi.fn(() => Promise.resolve());
      const watcher = watchAsteriskRestarts({ db, lookup, ...ringotel(rereg) });

      watcher.streamConnected();
      await watcher.idle();
      // No timer asks in between: an hour passes without a lookup.
      await vi.advanceTimersByTimeAsync(MS_PER_HOUR);
      expect(lookup).toHaveBeenCalledOnce();

      watcher.streamConnected();
      await watcher.idle();
      expect(lookup).toHaveBeenCalledTimes(2);
      expect(rereg).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it('re-registers on an announced start without asking core, once per start', async () => {
    const db = await makeTestDb();
    const lookup = vi.fn(core(STARTED));
    const rereg = vi.fn(() => Promise.resolve());
    const watcher = watchAsteriskRestarts({ db, lookup, ...ringotel(rereg) });
    watcher.streamConnected();
    await watcher.idle();
    expect(rereg).toHaveBeenCalledOnce();

    // Announced twice back to back, as the stream reconnect after it would repeat it.
    const later = at(1);
    watcher.asteriskStarted(later);
    watcher.asteriskStarted(later);
    await watcher.idle();

    expect(lookup).toHaveBeenCalledOnce();
    expect(rereg).toHaveBeenCalledTimes(2);
    const rows = await reregRows(db);
    expect(rows).toHaveLength(2);
  });

  it('keeps running after a failed check', async () => {
    const db = await makeTestDb();
    const rereg = vi.fn(() => Promise.resolve());
    let calls = 0;
    const watcher = watchAsteriskRestarts({
      db,
      lookup: core(STARTED),
      provider: () => {
        calls += 1;
        return calls === 1
          ? Promise.reject(new Error('database is locked'))
          : ringotel(rereg).provider();
      }
    });

    watcher.asteriskStarted(STARTED);
    watcher.asteriskStarted(STARTED);
    await watcher.idle();

    expect(rereg).toHaveBeenCalledOnce();
  });
});
