import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { addMsIso, nowIso, type Db, type Envelope } from '@zamfono/shared';
import { seedSettings } from '@zamfono/shared/testDb.js';

import { makeTestDb } from '#testing/testDb.js';

import type { Bus } from './jobs/backup.js';
import {
  countSipBansInForce,
  renderedSipBanListHash,
  renderSipBanList
} from './sipBanList.js';
import { recordSipBan } from './sipBanReport.js';

const DAY_MS = 86_400_000;
const DAY_S = 86_400;

let db: Db;
let published: Envelope[];
let bus: Bus;

beforeEach(async () => {
  db = await makeTestDb();
  await seedSettings(db);
  published = [];
  bus = {
    publish: envelope => published.push(envelope),
    enqueue: vi.fn(() => Promise.resolve())
  };
});

async function listText(): Promise<string> {
  return readFile(
    path.join(process.env.ASTERISK_GEN_DIR ?? '', 'sip_bans.list'),
    'utf8'
  );
}

/** A past ban of `address` that took `step` and ended `endedDaysAgo` days ago, by expiry. */
async function seedEndedBan(
  address: string,
  step: number,
  endedDaysAgo: number
): Promise<void> {
  const now = nowIso();
  await db
    .insertInto('sipBans')
    .values({
      id: `ban-${step}-${endedDaysAgo}`,
      address,
      step,
      failures: 10,
      createdAt: addMsIso(now, -(endedDaysAgo + 1) * DAY_MS),
      expiresAt: addMsIso(now, -endedDaysAgo * DAY_MS)
    })
    .execute();
}

describe('recordSipBan (§5.6 "Bans")', () => {
  it('bans a first offender for the first step, audits it, renders the list and emits sipBan.added', async () => {
    const ban = await recordSipBan(db, bus, {
      address: '203.0.113.7',
      failures: 12
    });
    expect(ban).not.toBeNull();
    const row = await db
      .selectFrom('sipBans')
      .selectAll()
      .executeTakeFirstOrThrow();
    expect(row).toMatchObject({
      address: '203.0.113.7',
      step: 1,
      failures: 12
    });
    expect(Date.parse(row.expiresAt ?? '') - Date.parse(row.createdAt)).toBe(
      DAY_MS
    );
    const audit = await db
      .selectFrom('auditLog')
      .selectAll()
      .executeTakeFirstOrThrow();
    expect(audit).toMatchObject({
      operation: 'sipBans.ban',
      channel: 'job',
      actorUserId: 'system',
      entityKind: 'sipBan',
      entityId: row.id,
      undoable: 0
    });
    const text = await listText();
    expect(text).toBe(`203.0.113.7 ${row.expiresAt}\n`);
    expect(renderedSipBanListHash()).toBe(
      createHash('sha256').update(text).digest('hex')
    );
    expect(published).toMatchObject([
      {
        type: 'sipBan.added',
        banId: row.id,
        address: '203.0.113.7',
        expiresAt: row.expiresAt
      }
    ]);
    expect(bus.enqueue).toHaveBeenCalledWith(published[0]);
    expect(await countSipBansInForce(db)).toBe(1);
  });

  it('changes nothing for an address with an active ban', async () => {
    await recordSipBan(db, bus, { address: '203.0.113.7', failures: 10 });
    expect(
      await recordSipBan(db, bus, { address: '203.0.113.7', failures: 10 })
    ).toBeNull();
    expect(await db.selectFrom('sipBans').select('id').execute()).toHaveLength(
      1
    );
    expect(published).toHaveLength(1);
  });

  it('ignores every report while the steps are empty, and renders an empty list with the active bans kept', async () => {
    await recordSipBan(db, bus, { address: '203.0.113.7', failures: 10 });
    await db.updateTable('settings').set({ sipBanStepsJson: '[]' }).execute();
    expect(
      await recordSipBan(db, bus, { address: '198.51.100.1', failures: 10 })
    ).toBeNull();
    await renderSipBanList(db);
    expect(await listText()).toBe('');
    expect(await countSipBansInForce(db)).toBe(0);
    expect(await db.selectFrom('sipBans').select('address').execute()).toEqual([
      { address: '203.0.113.7' }
    ]);
  });

  it('takes the step after a previous ban that ended within the lookback', async () => {
    await seedEndedBan('203.0.113.7', 1, 2);
    await recordSipBan(db, bus, { address: '203.0.113.7', failures: 10 });
    const row = await db
      .selectFrom('sipBans')
      .selectAll()
      .where('step', '=', 2)
      .executeTakeFirstOrThrow();
    expect(Date.parse(row.expiresAt ?? '') - Date.parse(row.createdAt)).toBe(
      31_536_000_000
    );
  });

  it('starts again at the first step once the previous ban ended longer ago than the lookback', async () => {
    await seedEndedBan('203.0.113.7', 2, 31);
    await recordSipBan(db, bus, { address: '203.0.113.7', failures: 10 });
    expect(
      await db
        .selectFrom('sipBans')
        .select('step')
        .orderBy('createdAt', 'desc')
        .executeTakeFirstOrThrow()
    ).toEqual({ step: 1 });
  });

  it('keeps the last step past the end of the list, a permanent ban rendered without an instant', async () => {
    await db
      .updateTable('settings')
      .set({ sipBanStepsJson: `[${DAY_S},null]` })
      .execute();
    await seedEndedBan('2001:db8:1:2::/64', 2, 1);
    const ban = await recordSipBan(db, bus, {
      address: '2001:db8:1:2::/64',
      failures: 10
    });
    expect(ban?.expiresAt).toBeNull();
    expect(
      await db
        .selectFrom('sipBans')
        .select('step')
        .where('id', '=', ban?.id ?? '')
        .executeTakeFirstOrThrow()
    ).toEqual({ step: 2 });
    expect(await listText()).toBe('2001:db8:1:2::/64\n');
  });
});
