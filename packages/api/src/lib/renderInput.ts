/**
 * The render's input (§9.1, §9.3, §9.4): every live user, device, ring group, parking slot, trunk
 * and hold-music asset the generated Asterisk configuration names, read from the database.
 */
import { sql } from 'kysely';

import type { Db } from '@zamfono/shared';

import { loadParkingSlots } from './ops/parking/_shared.js';
import { loadSettings } from './ops/settings/_shared.js';
import type { RenderInput } from './pjsip/render.js';
import { decrypt, type Keyring } from './secretbox.js';

type RingGroupIdRow = { ringGroupId: string; userId: string };

/**
 * Every user's ring-group memberships (§11.2 `ring_group_members`), direct or through a nested
 * `user_groups` tree: the recursive CTE mirrors the schema's own `user_group_groups_no_cycle`
 * trigger, since nesting can be arbitrarily deep and cycles are already rejected on write.
 */
async function ringGroupIdsByUser(db: Db): Promise<Map<string, string[]>> {
  const { rows } = await sql<RingGroupIdRow>`
    WITH RECURSIVE group_reach(root_group_id, group_id) AS (
      SELECT id, id FROM user_groups
      UNION
      SELECT gr.root_group_id, ugg.child_group_id
      FROM group_reach gr
      JOIN user_group_groups ugg ON ugg.parent_group_id = gr.group_id
    )
    SELECT DISTINCT
      rgm.group_id AS ringGroupId,
      COALESCE(rgm.user_id, ugu.user_id) AS userId
    FROM ring_group_members rgm
    LEFT JOIN group_reach gr ON gr.root_group_id = rgm.user_group_id
    LEFT JOIN user_group_users ugu ON ugu.group_id = gr.group_id
    WHERE COALESCE(rgm.user_id, ugu.user_id) IS NOT NULL
  `.execute(db);
  const byUser = new Map<string, string[]>();
  for (const row of rows) {
    const list = byUser.get(row.userId) ?? [];
    list.push(row.ringGroupId);
    byUser.set(row.userId, list);
  }
  return byUser;
}

type UserExtRow = { id: string; ext: string; name: string };

/** Live users with their extension (§11.2 `extensions`) and the live ring groups they belong to. */
async function loadUsers(
  db: Db
): Promise<{ rows: UserExtRow[]; users: RenderInput['users'] }> {
  const rows = await db
    .selectFrom('users')
    .innerJoin('extensions', 'extensions.userId', 'users.id')
    .select(['users.id as id', 'extensions.ext as ext', 'users.name as name'])
    .where('users.deletedAt', 'is', null)
    .execute();
  const groupsByUser = await ringGroupIdsByUser(db);
  const users = rows.map(row => ({
    id: row.id,
    ext: row.ext,
    name: row.name,
    ringGroupIds: groupsByUser.get(row.id) ?? []
  }));
  return { rows, users };
}

/** Live devices (§11.2 `devices`), their SIP password decrypted and owner extension attached. */
async function loadDevices(
  db: Db,
  kr: Keyring,
  extByUser: Map<string, string>
): Promise<RenderInput['devices']> {
  const rows = await db
    .selectFrom('devices')
    .selectAll()
    .where('deletedAt', 'is', null)
    .execute();
  return rows.map(row => ({
    id: row.id,
    userId: row.userId,
    ext: extByUser.get(row.userId) ?? '',
    kind: row.kind as 'manual' | 'ringotel',
    transport: row.transport as 'plain' | 'tls',
    allowedIps:
      row.allowedIpsJson === null
        ? null
        : (JSON.parse(row.allowedIpsJson) as string[]),
    sipUsername: row.sipUsername,
    sipPassword: decrypt(kr, row.sipPasswordEnc).toString('utf8')
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
      direction: host.direction as 'both' | 'inbound' | 'outbound'
    });
    hostsByTrunk.set(host.trunkId, list);
  }
  return trunkRows.map(row => ({
    id: row.id,
    name: row.name,
    authMode: row.authMode as 'ip' | 'registration',
    username: row.username,
    password:
      row.passwordEnc === null
        ? null
        : decrypt(kr, row.passwordEnc).toString('utf8'),
    inboundAuth: row.inboundAuth === 1,
    transport: row.transport as 'tcp' | 'tls' | 'udp',
    srtp: row.srtp === 1,
    tlsVerify: row.tlsVerify === 1,
    outboundProxy: row.outboundProxy,
    registerExpiryS: row.registerExpiryS,
    registerRetryS: row.registerRetryS,
    callerIdHeader: row.calleridHeader as 'both' | 'from' | 'pai',
    codecs:
      row.codecsJson === null ? null : (JSON.parse(row.codecsJson) as string[]),
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

/** The full `RenderInput` (Task 4) assembled from the live database. */
export async function loadRenderInput(
  db: Db,
  kr: Keyring
): Promise<RenderInput> {
  const settings = await loadSettings(db);
  const { rows: userRows, users } = await loadUsers(db);
  const extByUser = new Map(userRows.map(row => [row.id, row.ext]));
  const [devices, ringGroups, parkingSlots, trunks, moh] = await Promise.all([
    loadDevices(db, kr, extByUser),
    loadRingGroups(db),
    loadParkingSlots(db),
    loadTrunks(db, kr),
    loadMoh(db)
  ]);
  return {
    settings: {
      codecs: JSON.parse(settings.codecsJson) as string[],
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
