import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { newId, nowIso, type Db } from '@zamfono/shared';
import { defaultFeatureCodes } from '@zamfono/shared/testDb.js';

import { makeTestDb, owner, seedSettings } from '#lib/server/testDb.js';

import { runOperation, type RunInput } from '../runner.js';
import type { ConnectionSettings } from './_connectionSettings.js';

import './index.js';

const run: RunInput = { actor: owner, channel: 'rest', requestId: 'req-1' };
beforeEach(() => {
  vi.stubEnv('FQDN', 'pbx.example.com');
});

afterEach(() => {
  vi.unstubAllEnvs();
});

/** The `settings` singleton with non-default codecs and voicemail code, and user `Anna Huber` on 205. */
async function seedUser(db: Db): Promise<string> {
  await seedSettings(db, {
    codecsJson: '["g722","alaw"]',
    featureCodesJson: JSON.stringify({
      ...(await defaultFeatureCodes()),
      ownVoicemail: '*99'
    })
  });
  const userId = newId();
  await db
    .insertInto('users')
    .values({
      id: userId,
      name: 'Anna Huber',
      email: 'anna@x.test',
      role: 'user',
      createdAt: nowIso()
    })
    .execute();
  await db.insertInto('extensions').values({ ext: '205', userId }).execute();
  return userId;
}

type CreateOutput = {
  device: { id: string; sipUsername: string };
  connectionSettings: ConnectionSettings;
};

async function createManual(
  db: Db,
  userId: string,
  device: Record<string, unknown>
): Promise<CreateOutput> {
  return (await runOperation(
    db,
    'devices.create',
    { userId, label: 'Desk', kind: 'manual', ...device },
    run
  )) as CreateOutput;
}

describe("devices: a manual device's connection settings (§10.4)", () => {
  it('a tls device: TLS on 5061 with SRTP, every value from env and settings', async () => {
    const db = await makeTestDb();
    const userId = await seedUser(db);
    const { device, connectionSettings } = await createManual(db, userId, {});
    expect(connectionSettings).toEqual({
      server: 'pbx.example.com',
      domain: 'pbx.example.com',
      transport: ['tls'],
      port: 5061,
      username: device.sipUsername,
      password: expect.stringMatching(/^[A-Za-z0-9]{24}$/u) as string,
      extension: '205',
      displayName: 'Anna Huber',
      mediaEncryption: 'srtp',
      codecs: ['g722', 'alaw'],
      voicemailCode: '*99'
    });
  });

  it('a plain device: 5060 without SRTP, over both plain transports or the one enabled', async () => {
    const db = await makeTestDb();
    const userId = await seedUser(db);
    const plain = { transport: 'plain', allowedIps: ['203.0.113.7'] };
    const both = await createManual(db, userId, plain);
    expect(both.connectionSettings).toMatchObject({
      transport: ['udp', 'tcp'],
      port: 5060,
      mediaEncryption: 'none'
    });
    vi.stubEnv('SIP_UDP_ENABLED', 'false');
    const tcpOnly = await createManual(db, userId, plain);
    expect(tcpOnly.connectionSettings.transport).toEqual(['tcp']);
    vi.stubEnv('SIP_UDP_ENABLED', undefined);
    vi.stubEnv('SIP_TCP_ENABLED', 'false');
    const udpOnly = await createManual(db, userId, plain);
    expect(udpOnly.connectionSettings.transport).toEqual(['udp']);
  });

  it('revealCredentials returns the same set, audited', async () => {
    const db = await makeTestDb();
    const userId = await seedUser(db);
    const created = await createManual(db, userId, {});
    const revealed = await runOperation(
      db,
      'devices.revealCredentials',
      { id: created.device.id },
      run
    );
    expect(revealed).toEqual(created.connectionSettings);
    const audit = await db
      .selectFrom('auditLog')
      .select(['entityId', 'undoable'])
      .where('operation', '=', 'devices.revealCredentials')
      .executeTakeFirstOrThrow();
    expect(audit).toEqual({ entityId: created.device.id, undoable: 0 });
  });
});
