// Test-only: the configuration rows the call-control suites seed (`pipelineRig.ts`): the settings
// row, users, devices, parking slots and an outbound route.
import { newId, nowIso, type Db } from '@zamfono/shared';

import type { FakeAri } from '../ari/fake.js';

/** A throwaway forward-target/DID chain, just to satisfy `settings.main_did_id`'s FK. */
export async function seedSettings(db: Db): Promise<void> {
  const targetId = newId();
  await db
    .insertInto('forwardTargets')
    .values({ id: targetId, external: '+15550000' })
    .execute();
  const didId = newId();
  await db
    .insertInto('dids')
    .values({ id: didId, number: '+15551234', targetId, createdAt: nowIso() })
    .execute();
  await db
    .insertInto('settings')
    .values({
      id: 1,
      companyName: 'Zamfono',
      mainDidId: didId,
      country: 'DE',
      emergencyNumbersJson: '["112"]'
    })
    .execute();
}

/** A user at extension `ext`, without a device. */
export async function seedUser(db: Db, ext: string): Promise<string> {
  const id = newId();
  await db
    .insertInto('users')
    .values({
      id,
      name: `User ${ext}`,
      email: `${id}@example.com`,
      createdAt: nowIso()
    })
    .execute();
  await db
    .insertInto('extensions')
    .values({ ext, userId: id, ringGroupId: null, isParkingSlot: 0 })
    .execute();
  return id;
}

/** A manual device of `userId`'s, registered with the fake Asterisk unless `registered` is false. */
export async function seedDevice(
  rig: { db: Db; fakeAri: FakeAri },
  userId: string,
  sipUsername: string,
  registered = true
): Promise<void> {
  await rig.db
    .insertInto('devices')
    .values({
      id: newId(),
      userId,
      label: sipUsername,
      kind: 'manual',
      sipUsername,
      sipPasswordEnc: Buffer.from('secret'),
      createdAt: nowIso()
    })
    .execute();
  if (registered) {
    rig.fakeAri.registerEndpoint(sipUsername);
  }
}

/** A parking slot at extension `ext` (§10.2 "Call parking"). */
export async function seedSlot(db: Db, ext: string): Promise<void> {
  await db
    .insertInto('extensions')
    .values({ ext, userId: null, ringGroupId: null, isParkingSlot: 1 })
    .execute();
}

/** One `ip`-mode trunk with a single host and a catch-all route (§9.4 "Outbound routing"). */
export async function seedExternalRoute(
  db: Db,
  calleridHeader: 'from' | 'both' = 'from'
): Promise<string> {
  const trunkId = newId();
  await db
    .insertInto('trunks')
    .values({
      id: trunkId,
      name: 'trunk-1',
      priority: 1,
      emergency: 1,
      authMode: 'ip',
      username: null,
      passwordEnc: null,
      inboundAuth: 0,
      transport: 'udp',
      calleridHeader,
      maxChannels: null,
      createdAt: nowIso()
    })
    .execute();
  await db
    .insertInto('trunkHosts')
    .values({
      trunkId,
      priority: 1,
      host: 'sip.example.com',
      port: null,
      direction: 'both'
    })
    .execute();
  await db
    .insertInto('outboundRoutes')
    .values({
      id: newId(),
      priority: 1,
      trunkId,
      calleridDidId: null,
      createdAt: nowIso()
    })
    .execute();
  return trunkId;
}
