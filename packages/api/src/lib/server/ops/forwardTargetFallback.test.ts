import { describe, expect, it } from 'vitest';

import { nowIso, type Db } from '@zamfono/shared';
import { seedSettings } from '@zamfono/shared/testDb.js';

import { createTrunk, createUser } from '#testing/fixtures.js';
import { asRun, makeTestDb } from '#testing/testDb.js';

import { runPurge } from '../jobs/purge.js';
import { runOperation } from './runner.js';
import type { Actor } from './types.js';

import './dids/index.js';
import './settings/index.js';
import './trunks/index.js';
import './users/index.js';

// §10.1 step 7 "fallback", §10.3 "Forward targets", §11.2 `forward_targets.fallback_of_id`.

const BOT_URL = 'wss://bot.example/media?token=abc';

async function createSipTrunk(db: Db): Promise<string> {
  await createTrunk(db, {
    name: 'Carrier',
    hosts: [{ host: 'sip.carrier.example' }]
  });
  const { trunk } = await createTrunk(db, {
    name: 'Agent',
    emergency: false,
    hosts: [{ host: 'sip.agent.example', direction: 'outbound' }]
  });
  return trunk.id;
}

async function targetRows(db: Db): Promise<number> {
  const rows = await db.selectFrom('forwardTargets').select('id').execute();
  return rows.length;
}

async function setForwarding(
  db: Db,
  userId: string,
  target: Record<string, unknown>,
  actor?: Actor
): Promise<{ rules: { target: unknown }[] }> {
  return runOperation(
    db,
    'users.setForwarding',
    { id: userId, rules: [{ condition: 'unconditional', target }] },
    asRun(actor === undefined ? {} : { actor })
  ) as Promise<{ rules: { target: unknown }[] }>;
}

describe('forward-target fallbacks', () => {
  it('stores a fallback chain of any depth and reads it back on every read', async () => {
    const db = await makeTestDb();
    await seedSettings(db);
    const trunkId = await createSipTrunk(db);
    const seeded = await targetRows(db);
    const chain = {
      kind: 'external',
      external: '+4366412345',
      ringTimeoutS: 15,
      fallback: {
        kind: 'sip',
        trunkId,
        user: 'agent',
        fallback: {
          kind: 'webSocket',
          protocol: 'vonage',
          url: BOT_URL,
          fallback: { kind: 'mailboxUser', userId: 'owner' }
        }
      }
    };
    const did = (await runOperation(
      db,
      'dids.create',
      { number: '+4312345', target: chain },
      asRun()
    )) as { id: string; target: unknown };
    const expected = {
      kind: 'external',
      external: '+4366412345',
      ringTimeoutS: 15,
      record: false,
      fallback: {
        kind: 'sip',
        trunkId,
        user: 'agent',
        headers: expect.any(Array) as unknown,
        ringTimeoutS: null,
        record: false,
        fallback: {
          kind: 'webSocket',
          protocol: 'vonage',
          url: BOT_URL,
          sampleRate: 16000,
          record: false,
          fallback: { kind: 'mailboxUser', userId: 'owner' }
        }
      }
    };
    expect(did.target).toEqual(expected);
    const list = (await runOperation(db, 'dids.list', {}, asRun())) as {
      items: { id: string; target: unknown }[];
    };
    expect(list.items.find(item => item.id === did.id)?.target).toEqual(
      expected
    );
    expect(await targetRows(db)).toBe(seeded + 4);
  });

  it('refuses a fallback on a kind that cannot fail, and a ring timeout on a bot', async () => {
    const db = await makeTestDb();
    await seedSettings(db);
    const create = (target: Record<string, unknown>): Promise<unknown> =>
      runOperation(db, 'dids.create', { number: '+4312345', target }, asRun());
    await expect(
      create({
        kind: 'user',
        userId: 'owner',
        fallback: { kind: 'mailboxUser', userId: 'owner' }
      })
    ).rejects.toMatchObject({ status: 422 });
    await expect(
      create({
        kind: 'webSocket',
        protocol: 'twilio',
        url: BOT_URL,
        ringTimeoutS: 10
      })
    ).rejects.toMatchObject({ status: 422 });
    await expect(
      create({ kind: 'external', external: '+4366412345', ringTimeoutS: 0 })
    ).rejects.toMatchObject({ status: 422 });
  });

  it('deletes the whole chain with the rule that owns it, and the purge sweeps an orphaned one', async () => {
    const db = await makeTestDb();
    await seedSettings(db);
    const seeded = await targetRows(db);
    const chained = {
      kind: 'external',
      external: '+4366412345',
      fallback: {
        kind: 'external',
        external: '+4366499999',
        fallback: { kind: 'mailboxUser', userId: 'owner' }
      }
    };
    await setForwarding(db, 'owner', chained);
    expect(await targetRows(db)).toBe(seeded + 3);
    await setForwarding(db, 'owner', { kind: 'mailboxUser', userId: 'owner' });
    expect(await targetRows(db)).toBe(seeded + 1);

    const did = (await runOperation(
      db,
      'dids.create',
      { number: '+4312345', target: chained },
      asRun()
    )) as { id: string };
    await runOperation(
      db,
      'dids.update',
      { id: did.id, target: { kind: 'user', userId: 'owner' } },
      asRun()
    );
    await runPurge(db, nowIso());
    expect(await targetRows(db)).toBe(seeded + 2);
  });

  it('keeps a user who is only a fallback from being deleted', async () => {
    const db = await makeTestDb();
    await seedSettings(db);
    const anna = await createUser(db, '101');
    const did = (await runOperation(
      db,
      'dids.create',
      {
        number: '+4312345',
        target: {
          kind: 'external',
          external: '+4366412345',
          fallback: { kind: 'user', userId: anna }
        }
      },
      asRun()
    )) as { id: string };
    await expect(
      runOperation(db, 'users.delete', { id: anna }, asRun({ confirm: true }))
    ).rejects.toMatchObject({
      status: 409,
      references: [expect.objectContaining({ kind: 'did', id: did.id })]
    });
  });
});

describe('fallbacks a user sets on their own forwarding', () => {
  const anna: Actor = { id: 'owner', name: 'Owner', role: 'user' };

  it('lets a user give their external forward a ring timeout and a fallback chain', async () => {
    const db = await makeTestDb();
    await seedSettings(db);
    const result = await setForwarding(
      db,
      'owner',
      {
        kind: 'external',
        external: '+4366412345',
        ringTimeoutS: 20,
        fallback: {
          kind: 'external',
          external: '+4366499999',
          fallback: { kind: 'mailboxUser', userId: 'owner' }
        }
      },
      anna
    );
    expect(result.rules[0]?.target).toMatchObject({
      ringTimeoutS: 20,
      fallback: { fallback: { kind: 'mailboxUser' } }
    });
  });

  it('refuses an admin target anywhere in the chain', async () => {
    const db = await makeTestDb();
    await seedSettings(db);
    const trunkId = await createSipTrunk(db);
    const withFallback = (fallback: Record<string, unknown>) =>
      setForwarding(
        db,
        'owner',
        {
          kind: 'external',
          external: '+4366412345',
          fallback: { kind: 'external', external: '+4366499999', fallback }
        },
        anna
      );
    await expect(
      withFallback({ kind: 'sip', trunkId, user: 'agent' })
    ).rejects.toMatchObject({
      status: 403,
      title: 'a sip target is set by an admin'
    });
    await expect(
      withFallback({ kind: 'webSocket', protocol: 'twilio', url: BOT_URL })
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      withFallback({ kind: 'external', external: '+4311111', record: true })
    ).rejects.toMatchObject({
      status: 403,
      title: 'a recording target is set by an admin'
    });
  });

  it('keeps an admin-set chain the user sends back unchanged, and refuses it changed', async () => {
    const db = await makeTestDb();
    await seedSettings(db);
    const trunkId = await createSipTrunk(db);
    const adminSet = {
      kind: 'external',
      external: '+4366412345',
      ringTimeoutS: 15,
      fallback: { kind: 'sip', trunkId, user: 'agent' }
    };
    const stored = (await setForwarding(db, 'owner', adminSet)).rules[0]
      ?.target as Record<string, unknown>;
    const idsBefore = await db
      .selectFrom('forwardTargets')
      .select('id')
      .orderBy('id')
      .execute();

    await setForwarding(db, 'owner', stored, anna);
    expect(
      await db.selectFrom('forwardTargets').select('id').orderBy('id').execute()
    ).toEqual(idsBefore);

    await expect(
      setForwarding(db, 'owner', { ...stored, ringTimeoutS: 30 }, anna)
    ).rejects.toMatchObject({ status: 403 });
  });
});

describe('settings.maxForwardHops', () => {
  it('is 3 unless set, and takes any count from 1 up', async () => {
    const db = await makeTestDb();
    await seedSettings(db);
    const read = async (): Promise<unknown> =>
      (
        (await runOperation(db, 'settings.get', {}, asRun())) as {
          maxForwardHops: number;
        }
      ).maxForwardHops;
    expect(await read()).toBe(3);
    await runOperation(db, 'settings.update', { maxForwardHops: 25 }, asRun());
    expect(await read()).toBe(25);
    await expect(
      runOperation(db, 'settings.update', { maxForwardHops: 0 }, asRun())
    ).rejects.toMatchObject({ status: 422 });
  });
});
