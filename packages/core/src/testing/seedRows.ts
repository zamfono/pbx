// Test-only: the configuration rows the call-control suites seed beside the shared settings, DID
// and user seeders (`@zamfono/shared/testDb.js`): devices, extensions, ring groups, audio
// assets, forward targets, trunks and outbound routes. Each takes the row's columns on top of its
// defaults.
import { newId, nowIso, type Db } from '@zamfono/shared';
import { seedUser, type Row } from '@zamfono/shared/testDb.js';

import { registerDevice } from './pipelineDeps.js';
import type { Rig } from './pipelineRig.js';

/** A manual device `sipUsername` of `userId`'s, `device` on top. It rings only once registered
 * (`registerDevice`, or `seedRegisteredDevice`). */
export async function seedDevice(
  db: Db,
  userId: string,
  sipUsername: string,
  device: Row<'devices'> = {}
): Promise<void> {
  await db
    .insertInto('devices')
    .values({
      id: newId(),
      userId,
      label: sipUsername,
      kind: 'manual',
      sipUsername,
      sipPasswordEnc: Buffer.from('secret'),
      createdAt: nowIso(),
      ...device
    })
    .execute();
}

/** `seedDevice`, then the device's REGISTER reaching the rig's pipeline (`registerDevice`). */
export async function seedRegisteredDevice(
  rig: Pick<Rig, 'db' | 'fakeAri' | 'pipeline'>,
  userId: string,
  sipUsername: string
): Promise<void> {
  await seedDevice(rig.db, userId, sipUsername);
  await registerDevice(rig.fakeAri, rig.pipeline, sipUsername);
}

/** A user at extension `ext` with one registered device `e<ext>-a`. Returns the user's id. */
export async function seedUserWithDevice(
  rig: Pick<Rig, 'db' | 'fakeAri' | 'pipeline'>,
  ext: string
): Promise<string> {
  const id = await seedUser(rig.db, { ext });
  await seedRegisteredDevice(rig, id, `e${ext}-a`);
  return id;
}

/** An extension `ext`, `extension` on top: owned by nobody unless it names a user or group. */
export async function seedExtension(
  db: Db,
  ext: string,
  extension: Row<'extensions'> = {}
): Promise<void> {
  await db
    .insertInto('extensions')
    .values({
      ext,
      userId: null,
      ringGroupId: null,
      isParkingSlot: 0,
      ...extension
    })
    .execute();
}

/** A parking slot at extension `ext` (§10.2 "Call parking"). */
export async function seedSlot(db: Db, ext: string): Promise<void> {
  await seedExtension(db, ext, { isParkingSlot: 1 });
}

/** A simultaneous ring group, `group` on top, every other column at its default. Returns its id. */
export async function seedRingGroup(
  db: Db,
  group: Row<'ringGroups'> = {}
): Promise<string> {
  const id = group.id ?? newId();
  await db
    .insertInto('ringGroups')
    .values({
      name: `Group ${id}`,
      strategy: 'simultaneous',
      createdAt: nowIso(),
      ...group,
      id
    })
    .execute();
  return id;
}

/** An announcement `audio.wav`, `asset` on top. Returns its id. */
export async function seedAudioAsset(
  db: Db,
  asset: Row<'audioAssets'> = {}
): Promise<string> {
  const id = asset.id ?? newId();
  await db
    .insertInto('audioAssets')
    .values({
      label: 'Audio',
      kind: 'announcement',
      filename: 'audio.wav',
      createdAt: nowIso(),
      ...asset,
      id
    })
    .execute();
  return id;
}

/** A forward target with the columns of `target`. Returns its id. */
export async function seedForwardTarget(
  db: Db,
  target: Row<'forwardTargets'>
): Promise<string> {
  const id = target.id ?? newId();
  await db
    .insertInto('forwardTargets')
    .values({ ...target, id })
    .execute();
  return id;
}

/**
 * A trunk, `trunk` on top: emergency-capable over UDP, `registration` with an account unless
 * `trunk.authMode` is `ip`, named after its priority (default 1), reached at `hosts` (default one
 * host `sip<priority>.example.com`). Returns its id.
 */
export async function seedTrunk(
  db: Db,
  trunk: Row<'trunks'> = {},
  hosts?: string[]
): Promise<string> {
  const id = trunk.id ?? newId();
  const priority = trunk.priority ?? 1;
  const registration = (trunk.authMode ?? 'registration') === 'registration';
  await db
    .insertInto('trunks')
    .values({
      name: `trunk-${priority}`,
      emergency: 1,
      authMode: 'registration',
      username: registration ? `user${priority}` : null,
      passwordEnc: registration ? Buffer.from('secret') : null,
      inboundAuth: 0,
      transport: 'udp',
      callerIdHeader: 'from',
      createdAt: nowIso(),
      ...trunk,
      id,
      priority
    })
    .execute();
  const hostRows = (hosts ?? [`sip${priority}.example.com`]).map(
    (host, index) => ({
      trunkId: id,
      priority: index + 1,
      host,
      port: null,
      direction: 'both' as const
    })
  );
  if (hostRows.length > 0) {
    await db.insertInto('trunkHosts').values(hostRows).execute();
  }
  return id;
}

/** An outbound route over `trunkId`, `route` on top, at priority 1 unless it says otherwise.
 * Returns its id. */
export async function seedRoute(
  db: Db,
  trunkId: string,
  route: Row<'outboundRoutes'> = {}
): Promise<string> {
  const id = route.id ?? newId();
  await db
    .insertInto('outboundRoutes')
    .values({ priority: 1, createdAt: nowIso(), ...route, id, trunkId })
    .execute();
  return id;
}

/** One `ip`-mode trunk with a single host and a catch-all route (§9.4 "Outbound routing"). */
export async function seedExternalRoute(
  db: Db,
  callerIdHeader: 'from' | 'both' = 'from'
): Promise<string> {
  const trunkId = await seedTrunk(db, { authMode: 'ip', callerIdHeader }, [
    'sip.example.com'
  ]);
  await seedRoute(db, trunkId);
  return trunkId;
}
