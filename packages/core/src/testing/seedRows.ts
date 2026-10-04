// Test-only: the configuration rows the call-control suites seed (`pipelineRig.ts`): the settings
// row, DIDs, users, devices, parking slots and an outbound route.
import type { Insertable } from 'kysely';

import { newId, nowIso, type DB, type Db } from '@zamfono/shared';

import type { FakeAri } from './ari/fake.js';

type Row<Table extends keyof DB> = Partial<Insertable<DB[Table]>>;

/** A DID `number` routed to `targetId`, or to a forward target of its own that forwards to an
 * external number. Returns its id. */
export async function seedDid(
  db: Db,
  number: string,
  targetId?: string
): Promise<string> {
  let didTargetId = targetId;
  if (didTargetId === undefined) {
    didTargetId = newId();
    await db
      .insertInto('forwardTargets')
      .values({ id: didTargetId, external: '+15550000' })
      .execute();
  }
  const id = newId();
  await db
    .insertInto('dids')
    .values({ id, number, targetId: didTargetId, createdAt: nowIso() })
    .execute();
  return id;
}

/** The `settings` singleton, `settings` on top. Unless `settings.mainDidId` names one, the main
 * DID is `+15551234`, forwarding to an external number. Returns the main DID's id. */
export async function seedSettings(
  db: Db,
  settings: Row<'settings'> = {}
): Promise<string> {
  const mainDidId = settings.mainDidId ?? (await seedDid(db, '+15551234'));
  await db
    .insertInto('settings')
    .values({
      id: 1,
      companyName: 'Zamfono',
      country: 'DE',
      emergencyNumbersJson: '["112"]',
      ...settings,
      mainDidId
    })
    .execute();
  return mainDidId;
}

/** A user without a device, `user` on top, at extension `ext` if one is given. Returns its id. */
export async function seedUser(
  db: Db,
  { ext, ...user }: Row<'users'> & { ext?: string } = {}
): Promise<string> {
  const id = user.id ?? newId();
  await db
    .insertInto('users')
    .values({
      name: 'Test User',
      email: `${id}@example.com`,
      createdAt: nowIso(),
      ...user,
      id
    })
    .execute();
  if (ext !== undefined) {
    await db
      .insertInto('extensions')
      .values({ ext, userId: id, ringGroupId: null, isParkingSlot: 0 })
      .execute();
  }
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
  callerIdHeader: 'from' | 'both' = 'from'
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
      callerIdHeader,
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
      callerIdDidId: null,
      createdAt: nowIso()
    })
    .execute();
  return trunkId;
}
