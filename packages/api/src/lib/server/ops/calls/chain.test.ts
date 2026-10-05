import { describe, expect, it } from 'vitest';

import { newId, nowIso, type Db } from '@zamfono/shared';
import { seedSettings, seedUser } from '@zamfono/shared/testDb.js';

import { asRun, makeTestDb } from '#testing/testDb.js';

import { runOperation } from '../runner.js';
import type { Actor } from '../types.js';

import './index.js';

const anna: Actor = { id: 'u1', name: 'Anna', role: 'user' };

/** An ended internal call, a leg of `parentCallId` when given. Returns its id. */
async function seedCall(
  db: Db,
  fields: {
    parentCallId?: string;
    answeredByUserId?: string;
    startedAt?: string;
    inProgress?: boolean;
  }
): Promise<string> {
  const id = newId();
  await db
    .insertInto('calls')
    .values({
      id,
      direction: 'internal',
      fromUri: '101',
      toUri: '102',
      status: 'answered',
      startedAt: fields.startedAt ?? nowIso(),
      endedAt: fields.inProgress === true ? null : nowIso(),
      parentCallId: fields.parentCallId ?? null,
      answeredByUserId: fields.answeredByUserId ?? null
    })
    .execute();
  return id;
}

async function listIds(
  db: Db,
  input: Record<string, unknown>,
  actor?: Actor
): Promise<string[]> {
  const result = (await runOperation(
    db,
    'calls.list',
    input,
    asRun(actor === undefined ? {} : { actor })
  )) as { items: { id: string }[] };
  return result.items.map(item => item.id).sort();
}

describe('the call history chain (§10.3 "Call history")', () => {
  it("calls.list with parentCallId returns the rows whose parent is that call, within a user's own scope", async () => {
    const db = await makeTestDb();
    await seedSettings(db);
    await seedUser(db, { id: 'u1', name: 'u1' });
    const parent = await seedCall(db, {});
    const ownLeg = await seedCall(db, {
      parentCallId: parent,
      answeredByUserId: 'u1'
    });
    const otherLeg = await seedCall(db, { parentCallId: parent });
    await seedCall(db, { parentCallId: ownLeg });

    expect(await listIds(db, { parentCallId: parent })).toEqual(
      [ownLeg, otherLeg].sort()
    );
    expect(await listIds(db, { parentCallId: parent }, anna)).toEqual([ownLeg]);
    expect(await listIds(db, { parentCallId: newId() })).toEqual([]);
  });

  it("calls.get lists the ended direct children by start, within a user's own scope", async () => {
    const db = await makeTestDb();
    await seedSettings(db);
    await seedUser(db, { id: 'u1', name: 'u1' });
    const parent = await seedCall(db, { answeredByUserId: 'u1' });
    const later = await seedCall(db, {
      parentCallId: parent,
      answeredByUserId: 'u1',
      startedAt: '2026-10-05T10:02:00.000Z'
    });
    const earlier = await seedCall(db, {
      parentCallId: parent,
      startedAt: '2026-10-05T10:01:00.000Z'
    });
    await seedCall(db, { parentCallId: parent, inProgress: true });
    await seedCall(db, { parentCallId: later });

    const asAdmin = (await runOperation(
      db,
      'calls.get',
      { id: parent },
      asRun()
    )) as { childCallIds: string[] };
    const asUser = (await runOperation(
      db,
      'calls.get',
      { id: parent },
      asRun({ actor: anna })
    )) as { childCallIds: string[] };

    expect(asAdmin.childCallIds).toEqual([earlier, later]);
    expect(asUser.childCallIds).toEqual([later]);
  });
});
