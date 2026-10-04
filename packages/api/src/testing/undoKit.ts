import * as privateEnv from '$app/env/private';
import { sql } from 'kysely';
import { expect, vi } from 'vitest';

import {
  changesColumn,
  newId,
  nowIso,
  type AudioKind,
  type Db
} from '@zamfono/shared';
import { seedSettings } from '@zamfono/shared/testDb.js';

import { OUTCOME_OPERATIONS } from '#lib/server/ops/outcomeLog.js';
import { runOperation } from '#lib/server/ops/runner.js';
import { propagateConfig } from '#lib/server/propagation.js';
import { encrypt, keyringFromEnv } from '#lib/server/secretbox.js';

import { installRingotelFake, type RingotelFake } from './ringotelFake.js';
import { asConfirmedRun, makeTestDb } from './testDb.js';

/**
 * One undoable operation call with a side effect beyond its own row (§5.8): `arrange` seeds what
 * the call acts on and answers the id `act` needs; `act` makes the one call whose entry is undone.
 */
export type UndoCase = {
  name: string;
  arrange: (db: Db) => Promise<string>;
  act: (db: Db, id: string) => Promise<unknown>;
};

/** A forward target, external, for inputs that need one. */
export const EXTERNAL = { kind: 'external', external: '+490000000' };

/** Runs `name` as the owner, confirmation given. */
export async function run<Out = { id: string }>(
  db: Db,
  name: string,
  input: object
): Promise<Out> {
  return (await runOperation(db, name, input, asConfirmedRun())) as Out;
}

/** An audio asset of `kind`, inserted directly; returns its id. */
export async function seedAudio(db: Db, kind: AudioKind): Promise<string> {
  const id = newId();
  await db
    .insertInto('audioAssets')
    .values({
      id,
      label: kind,
      kind,
      filename: `${id}.wav`,
      createdAt: nowIso()
    })
    .execute();
  return id;
}

/** A ringotel device of `userId`'s; returns its id. */
export async function ringotelDevice(db: Db, userId: string): Promise<string> {
  const created = await run<{ device: { id: string } }>(db, 'devices.create', {
    userId,
    label: 'App',
    kind: 'ringotel'
  });
  return created.device.id;
}

// A column naming a `forward_targets` row: compared by what the target forwards to, since a
// replace writes a fresh row and the purge sweeps the one it left (§5.9).
const TARGET_COLUMN = /^(?:.+T|t)argetId$/u;

/**
 * Every live row of every table, as JSON, each table's rows sorted; a soft-deleted row counts as
 * gone, and a forward target as its contents. Neither the audit log nor `tokens` is state an undo
 * restores: revoked tokens stay revoked (§5.9), and a deleted user's set-password link is refused
 * when redeemed.
 */
async function liveState(db: Db): Promise<Record<string, string[]>> {
  const tables = await sql<{ name: string }>`
    select name from sqlite_master
    where type = 'table' and name not like 'sqlite_%' and name not like 'kysely_%'
      and name not in ('audit_log', 'forward_targets', 'tokens')`.execute(db);
  const targets = new Map(
    (await db.selectFrom('forwardTargets').selectAll().execute()).map(
      ({ id, ...target }) => [id, target]
    )
  );
  const entries = await Promise.all(
    tables.rows.map(async ({ name }) => {
      const { rows } = await sql<
        Record<string, unknown>
      >`select * from ${sql.table(name)}`.execute(db);
      const live = rows
        .filter(row => row.deletedAt === undefined || row.deletedAt === null)
        .map(row =>
          JSON.stringify(row, (key, value: unknown) =>
            TARGET_COLUMN.test(key) && typeof value === 'string'
              ? targets.get(value)
              : value
          )
        )
        .sort();
      return [name, live] as const;
    })
  );
  return Object.fromEntries(entries);
}

/** What Ringotel holds: its users by extension, their remote ids aside, and the branch roster. */
function remoteState(fake: RingotelFake): unknown {
  return {
    users: fake.users
      .map(user => ({ ...user, id: undefined }))
      .sort((left, right) => left.extension.localeCompare(right.extension)),
    provision: fake.branchProvision
  };
}

/** The rows only in `before` and only in `after`, per table that differs. */
function stateDiff(
  before: Record<string, string[]>,
  after: Record<string, string[]>
): Record<string, { gone: string[]; added: string[] }> {
  const diff: Record<string, { gone: string[]; added: string[] }> = {};
  for (const [table, rows] of Object.entries(before)) {
    const now = after[table] ?? [];
    const gone = rows.filter(row => !now.includes(row));
    const added = now.filter(row => !rows.includes(row));
    if (gone.length + added.length > 0) {
      diff[table] = { gone, added };
    }
  }
  return diff;
}

/** The reload kinds `propagateConfig` was asked for since the last clear, and whether at all. */
function takePropagation(): { called: boolean; kinds: Set<string> } {
  const { calls } = vi.mocked(propagateConfig).mock;
  const taken = {
    called: calls.length > 0,
    kinds: new Set(calls.flatMap(call => call[1]))
  };
  vi.mocked(propagateConfig).mockClear();
  return taken;
}

/**
 * On a tenant connected to Ringotel, runs `undoCase`'s call, then `audit.undo` of its entry, and
 * expects everything back as it was before the call (§5.8): every live row, what Ringotel holds,
 * the propagation the call caused owed again with the same reload kinds, the entry marked undone
 * and the undo recorded as its reverse.
 */
export async function expectUndoRestores(undoCase: UndoCase): Promise<void> {
  const db = await makeTestDb();
  await seedSettings(db, {
    ringotelOrgId: 'org-1',
    ringotelBranchId: 'branch-1',
    ringotelApiTokenEnc: encrypt(keyringFromEnv(privateEnv), 'ringotel-key')
  });
  const ringotel = installRingotelFake();
  try {
    // A profile push, so the branch holds its provision before the call (§10.4).
    await run(db, 'settings.update', { ringotelMaxRegs: 4 });
    const id = await undoCase.arrange(db);
    const before = await liveState(db);
    const remoteBefore = remoteState(ringotel);
    const earlier = await db.selectFrom('auditLog').select('id').execute();
    takePropagation();

    await undoCase.act(db, id);

    const forward = takePropagation();
    const entries = await db
      .selectFrom('auditLog')
      .selectAll()
      .where(
        'id',
        'not in',
        earlier.map(row => row.id)
      )
      .execute();
    const [entry, ...more] = entries.filter(
      row => !OUTCOME_OPERATIONS.has(row.operation)
    );
    expect(more).toEqual([]);
    if (entry === undefined) {
      throw new Error(`${undoCase.name}: the call wrote no audit entry`);
    }

    await run(db, 'audit.undo', { id: entry.id });

    expect(stateDiff(before, await liveState(db))).toEqual({});
    expect(remoteState(ringotel)).toEqual(remoteBefore);
    expect(takePropagation()).toEqual(forward);
    const undone = await db
      .selectFrom('auditLog')
      .select(['undoneAt', 'changesJson'])
      .where('revertsId', '=', entry.id)
      .executeTakeFirstOrThrow();
    expect(undone.undoneAt).toBeNull();
    expect(changesColumn.decode(undone.changesJson)).toEqual(
      changesColumn
        .decode(entry.changesJson)
        .map(({ field, from, to }) => ({ field, from: to, to: from }))
    );
    const reverted = await db
      .selectFrom('auditLog')
      .select('undoneAt')
      .where('id', '=', entry.id)
      .executeTakeFirstOrThrow();
    expect(reverted.undoneAt).not.toBeNull();
  } finally {
    ringotel.restore();
  }
}
