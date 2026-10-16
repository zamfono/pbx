import { describe, expect, it } from 'vitest';

import { type Db } from '@zamfono/shared';
import { seedSettings } from '@zamfono/shared/testDb.js';

import { asRun, makeTestDb } from '#testing/testDb.js';

import { runOperation } from './runner.js';
import type { Actor } from './types.js';

import './dids/index.js';
import './hours/index.js';
import './ooo/index.js';
import './users/index.js';

// The seeded user acting as a self-service `user` on their own scope, as `ooo`'s tests do.
const self: Actor = { id: 'owner', name: 'Owner', role: 'user' };

const BOT_URL = 'wss://bot.example/media?token=abc';

async function createDid(
  db: Db,
  target: Record<string, unknown>
): Promise<{ id: string; target: unknown }> {
  return runOperation(
    db,
    'dids.create',
    { number: '+4312345', target },
    asRun()
  ) as Promise<{ id: string; target: unknown }>;
}

async function setForwarding(
  db: Db,
  target: Record<string, unknown>,
  actor?: Actor
): Promise<unknown> {
  return runOperation(
    db,
    'users.setForwarding',
    { id: 'owner', rules: [{ condition: 'unconditional', target }] },
    asRun(actor === undefined ? {} : { actor })
  );
}

// §9.4 "WebSocket targets", §10.3 "Forward targets", §11.2 `forward_targets`.
describe('webSocket forward targets', () => {
  it('stores a twilio target at 8 kHz and a vonage one at 16 kHz unless given, reading both back', async () => {
    const db = await makeTestDb();
    await seedSettings(db);
    const twilio = await createDid(db, {
      kind: 'webSocket',
      protocol: 'twilio',
      url: BOT_URL
    });
    expect(twilio.target).toEqual({
      kind: 'webSocket',
      protocol: 'twilio',
      url: BOT_URL,
      sampleRate: 8000,
      record: false
    });
    const vonage = (await runOperation(
      db,
      'dids.update',
      {
        id: twilio.id,
        target: {
          kind: 'webSocket',
          protocol: 'vonage',
          url: 'ws://10.0.0.5:8080/bot',
          record: true
        }
      },
      asRun()
    )) as { target: unknown };
    expect(vonage.target).toEqual({
      kind: 'webSocket',
      protocol: 'vonage',
      url: 'ws://10.0.0.5:8080/bot',
      sampleRate: 16000,
      record: true
    });
    const row = await db
      .selectFrom('dids')
      .innerJoin('forwardTargets', 'forwardTargets.id', 'dids.targetId')
      .select([
        'forwardTargets.webSocketProtocol',
        'forwardTargets.webSocketSampleRate',
        'forwardTargets.recordCalls'
      ])
      .where('dids.id', '=', twilio.id)
      .executeTakeFirstOrThrow();
    expect(row).toEqual({
      webSocketProtocol: 'vonage',
      webSocketSampleRate: 16000,
      recordCalls: 1
    });
  });

  it.each([
    ['an http URL', { protocol: 'vonage', url: 'https://bot.example/' }],
    ['a URL without a host', { protocol: 'vonage', url: 'wss://' }],
    [
      'a twilio target at 16 kHz',
      { protocol: 'twilio', url: BOT_URL, sampleRate: 16000 }
    ],
    [
      'a sample rate no protocol speaks',
      { protocol: 'vonage', url: BOT_URL, sampleRate: 44100 }
    ],
    ['an unknown protocol', { protocol: 'plivo', url: BOT_URL }],
    [
      'a field of another kind',
      { protocol: 'vonage', url: BOT_URL, headers: [] }
    ],
    [
      'a URL over 2048 characters',
      { protocol: 'vonage', url: `wss://${'a'.repeat(2043)}` }
    ]
  ])('refuses %s', async (label, fields) => {
    const db = await makeTestDb();
    await seedSettings(db);
    await expect(
      createDid(db, { kind: 'webSocket', ...fields })
    ).rejects.toMatchObject({ status: 422 });
  });

  it('lets an admin set one on a user, refuses a user who sets one, and keeps it when sent back unchanged', async () => {
    const db = await makeTestDb();
    await seedSettings(db);
    const target = { kind: 'webSocket', protocol: 'twilio', url: BOT_URL };
    await setForwarding(db, target);
    // Sent back as it reads, the admin's rule stays.
    await expect(
      setForwarding(db, { ...target, sampleRate: 8000, record: false }, self)
    ).resolves.toBeDefined();
    // Any change to it is a new admin target.
    await expect(
      setForwarding(db, { ...target, url: 'wss://other.example/' }, self)
    ).rejects.toMatchObject({
      status: 403,
      message: 'a webSocket target is set by an admin'
    });
    await expect(
      runOperation(
        db,
        'hours.set',
        {
          scope: { kind: 'user', id: 'owner' },
          closedTarget: target,
          intervals: []
        },
        asRun({ actor: self })
      )
    ).rejects.toMatchObject({ status: 403 });
  });
});
