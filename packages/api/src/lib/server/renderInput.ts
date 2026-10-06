/**
 * The render's input (§9.1, §9.3, §9.4): every live user, device, ring group, parking slot, trunk
 * and hold-music asset the generated Asterisk configuration names, read from the database.
 */
import { allowedIpsColumn, codecsColumn, type Db } from '@zamfono/shared';

import { loadParkingSlots } from './ops/parking/_shared.js';
import { loadSettings } from './ops/settings/_shared.js';
import type { RenderInput } from './pjsip/shared.js';
import { ringGroupMemberships } from './ringGroupMembership.js';
import { decrypt, type Keyring } from './secretbox.js';

/** Every user's ring groups (`ringGroupMemberships`), by user id. */
async function ringGroupIdsByUser(db: Db): Promise<Map<string, string[]>> {
  const byUser = new Map<string, string[]>();
  for (const row of await ringGroupMemberships(db)) {
    const list = byUser.get(row.userId) ?? [];
    list.push(row.ringGroupId);
    byUser.set(row.userId, list);
  }
  return byUser;
}

/** Live users with their extension (§11.2 `extensions`) and the live ring groups they belong to. */
async function loadUsers(db: Db): Promise<RenderInput['users']> {
  const rows = await db
    .selectFrom('users')
    .innerJoin('extensions', 'extensions.userId', 'users.id')
    .select(['users.id as id', 'extensions.ext as ext', 'users.name as name'])
    .where('users.deletedAt', 'is', null)
    .execute();
  const groupsByUser = await ringGroupIdsByUser(db);
  return rows.map(row => ({
    id: row.id,
    ext: row.ext,
    name: row.name,
    ringGroupIds: groupsByUser.get(row.id) ?? []
  }));
}

/** Live devices (§11.2 `devices`) of live users holding an extension, their SIP password
 * decrypted. */
async function loadDevices(
  db: Db,
  kr: Keyring
): Promise<RenderInput['devices']> {
  const rows = await db
    .selectFrom('devices')
    .innerJoin('users', 'users.id', 'devices.userId')
    .innerJoin('extensions', 'extensions.userId', 'devices.userId')
    .selectAll('devices')
    .where('devices.deletedAt', 'is', null)
    .where('users.deletedAt', 'is', null)
    .execute();
  return rows.map(row => ({
    id: row.id,
    userId: row.userId,
    kind: row.kind,
    transport: row.transport,
    allowedIps: allowedIpsColumn.nullable().decode(row.allowedIpsJson),
    sipUsername: row.sipUsername,
    sipPassword: decrypt(
      kr,
      'devices.sipPasswordEnc',
      row.sipPasswordEnc
    ).toString('utf8')
  }));
}

/** Live ring groups (§11.2 `ring_groups`) with their extension. */
async function loadRingGroups(db: Db): Promise<RenderInput['ringGroups']> {
  return db
    .selectFrom('ringGroups')
    .innerJoin('extensions', 'extensions.ringGroupId', 'ringGroups.id')
    .select(['ringGroups.id as id', 'extensions.ext as ext'])
    .where('ringGroups.deletedAt', 'is', null)
    .execute();
}

/** Live trunks (§11.2 `trunks`, `trunk_hosts`) with their credentials decrypted and hosts attached. */
async function loadTrunks(db: Db, kr: Keyring): Promise<RenderInput['trunks']> {
  const trunkRows = await db
    .selectFrom('trunks')
    .selectAll()
    .where('deletedAt', 'is', null)
    .execute();
  const hostRows = await db.selectFrom('trunkHosts').selectAll().execute();
  const hostsByTrunk = new Map<
    string,
    RenderInput['trunks'][number]['hosts']
  >();
  for (const host of hostRows) {
    const list = hostsByTrunk.get(host.trunkId) ?? [];
    list.push({
      priority: host.priority,
      host: host.host,
      port: host.port,
      direction: host.direction
    });
    hostsByTrunk.set(host.trunkId, list);
  }
  return trunkRows.map(row => ({
    id: row.id,
    name: row.name,
    authMode: row.authMode,
    username: row.username,
    password:
      row.passwordEnc === null
        ? null
        : decrypt(kr, 'trunks.passwordEnc', row.passwordEnc).toString('utf8'),
    inboundAuth: row.inboundAuth === 1,
    transport: row.transport,
    srtp: row.srtp === 1,
    tlsVerify: row.tlsVerify === 1,
    qualify: row.qualify === 1,
    outboundProxy: row.outboundProxy,
    registerExpiryS: row.registerExpiryS,
    registerRetryS: row.registerRetryS,
    callerIdHeader: row.callerIdHeader,
    codecs: codecsColumn.nullable().decode(row.codecsJson),
    hosts: hostsByTrunk.get(row.id) ?? []
  }));
}

/** Live `moh`-kind audio assets (§11.2 `audio_assets`), one class per asset (§9.1). */
async function loadMoh(db: Db): Promise<RenderInput['moh']> {
  return db
    .selectFrom('audioAssets')
    .select(['id', 'filename'])
    .where('kind', '=', 'moh')
    .where('deletedAt', 'is', null)
    .execute();
}

// Asterisk's built-in class, shipped statically in the image (§10.2 "Hold music").
const DEFAULT_MOH_CLASS = 'default';

/** The class a held party hears (§10.2 "Hold music"): `settings.hold_moh_audio_id`'s own class
 * while that asset is a rendered one, else the static default class. */
function holdMohClass(
  holdMohAudioId: string | null,
  moh: RenderInput['moh']
): string {
  return holdMohAudioId !== null &&
    moh.some(asset => asset.id === holdMohAudioId)
    ? holdMohAudioId
    : DEFAULT_MOH_CLASS;
}

/** The full `RenderInput`: the live database's rows, the stack's `fqdn` and its `sipHost`. */
export async function loadRenderInput(
  db: Db,
  kr: Keyring,
  fqdn: string,
  sipHost: string
): Promise<RenderInput> {
  const settings = await loadSettings(db);
  const [users, devices, ringGroups, parkingSlots, trunks, moh] =
    await Promise.all([
      loadUsers(db),
      loadDevices(db, kr),
      loadRingGroups(db),
      loadParkingSlots(db),
      loadTrunks(db, kr),
      loadMoh(db)
    ]);
  return {
    fqdn,
    sipHost,
    settings: {
      codecs: codecsColumn.decode(settings.codecsJson),
      ringotelMaxRegs: settings.ringotelMaxRegs,
      extLength: settings.extLength,
      holdMohClass: holdMohClass(settings.holdMohAudioId, moh)
    },
    users,
    devices,
    ringGroups,
    parkingSlots,
    trunks,
    moh
  };
}
