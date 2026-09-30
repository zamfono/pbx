import type { Selectable } from 'kysely';
import { z } from 'zod';

import type { Db, DB, TrunkStatus } from '@zamfono/shared';

import { logLevelWire, type LogLevelColumns } from '../settings/logLevel.js';

export const STATUS_NOT_FOUND = 404;
export const STATUS_UNPROCESSABLE_ENTITY = 422;

/** The highest TCP/UDP port number, shared by create's and update's host schemas. */
export const MAX_PORT = 65535;

/** The trunk offer codecs a client or trunk list may name (§9.1, §9.4); the image ships no others. */
export const CODECS = ['opus', 'g722', 'amrwb', 'amr', 'alaw', 'ulaw'] as const;
export type Codec = (typeof CODECS)[number];

export const TRANSPORTS = ['udp', 'tcp', 'tls'] as const;
export type Transport = (typeof TRANSPORTS)[number];

export const HOST_DIRECTIONS = ['both', 'outbound', 'inbound'] as const;
export type HostDirection = (typeof HOST_DIRECTIONS)[number];

export const NUMBER_FORMATS = ['e164', 'national'] as const;
export type NumberFormat = (typeof NUMBER_FORMATS)[number];

export const CALLERID_HEADERS = ['from', 'pai', 'both'] as const;
export type CallerIdHeader = (typeof CALLERID_HEADERS)[number];

export const AUTH_MODES = ['registration', 'ip'] as const;
export type AuthMode = (typeof AUTH_MODES)[number];

export type TrunkRow = Selectable<DB['trunks']>;
export type TrunkHostRow = Selectable<DB['trunkHosts']>;

export type HostInput = {
  host: string;
  port?: number | null;
  direction?: HostDirection;
};

/** A trunk host as create or update accepts it; `port` null or omitted means SRV resolution. */
export const hostInputSchema = z
  .object({
    host: z.string().min(1),
    port: z.number().int().min(1).max(MAX_PORT).nullable().optional(),
    direction: z.enum(HOST_DIRECTIONS).optional()
  })
  .strict();

export type HostWire = {
  host: string;
  port: number | null;
  direction: HostDirection;
};

/** The scalar (non-host, non-status) fields of a trunk, in their wire shape (§9.4, §10.3). */
export type TrunkScalars = {
  name: string;
  /** `trunks.emergency`: only these trunks carry emergency calls (§9.4 "Emergency trunks"). */
  emergency: boolean;
  authMode: AuthMode;
  username: string | null;
  inboundAuth: boolean;
  transport: Transport;
  /** `trunks.srtp`: SDES-SRTP media, `tls` trunks only (§9.4 "Signaling"). */
  srtp: boolean;
  /** `trunks.tls_verify`: the provider's certificate is checked; applies while `transport` is `tls`. */
  tlsVerify: boolean;
  /** `trunks.qualify`: an `ip` trunk's contact is OPTIONS-probed for its status; ignored for
   * `registration` (§9.4 "Provisioning and status"). */
  qualify: boolean;
  outboundProxy: string | null;
  registerExpiryS: number | null;
  registerRetryS: number | null;
  inboundNumberFormat: NumberFormat;
  callerIdFormat: NumberFormat;
  callerIdHeader: CallerIdHeader;
  clir: boolean | null;
  codecs: Codec[] | null;
  maxChannels: number | null;
};

export type TrunkWire = TrunkScalars &
  LogLevelColumns & {
    id: string;
    priority: number;
    hosts: HostWire[];
    status: TrunkStatus['status'];
    statusChangedAt: string | null;
  };

export async function loadTrunkRow(
  db: Db,
  id: string
): Promise<TrunkRow | undefined> {
  return db
    .selectFrom('trunks')
    .selectAll()
    .where('id', '=', id)
    .where('deletedAt', 'is', null)
    .executeTakeFirst();
}

/** Whether any live trunk has `trunks.emergency` set (§9.4 "Emergency trunks"). */
export async function hasEmergencyTrunk(db: Db): Promise<boolean> {
  const row = await db
    .selectFrom('trunks')
    .select('id')
    .where('emergency', '=', 1)
    .where('deletedAt', 'is', null)
    .executeTakeFirst();
  return row !== undefined;
}

export async function loadTrunkHosts(
  db: Db,
  trunkId: string
): Promise<TrunkHostRow[]> {
  return db
    .selectFrom('trunkHosts')
    .selectAll()
    .where('trunkId', '=', trunkId)
    .orderBy('priority')
    .execute();
}

/** Replaces `trunkId`'s host list as a whole; `priority` is each host's position (§11.2 "trunk_hosts"). */
export async function replaceTrunkHosts(
  db: Db,
  trunkId: string,
  hosts: HostInput[]
): Promise<void> {
  await db.deleteFrom('trunkHosts').where('trunkId', '=', trunkId).execute();
  if (hosts.length === 0) {
    return;
  }
  await db
    .insertInto('trunkHosts')
    .values(
      hosts.map((host, index) => ({
        trunkId,
        priority: index + 1,
        host: host.host,
        port: host.port ?? null,
        direction: host.direction ?? 'both'
      }))
    )
    .execute();
}

export function scalarsFromRow(row: TrunkRow): TrunkScalars {
  return {
    name: row.name,
    emergency: row.emergency === 1,
    authMode: row.authMode as AuthMode,
    username: row.username,
    inboundAuth: row.inboundAuth === 1,
    transport: row.transport as Transport,
    srtp: row.srtp === 1,
    tlsVerify: row.tlsVerify === 1,
    qualify: row.qualify === 1,
    outboundProxy: row.outboundProxy,
    registerExpiryS: row.registerExpiryS,
    registerRetryS: row.registerRetryS,
    inboundNumberFormat: row.inboundNumberFormat as NumberFormat,
    callerIdFormat: row.calleridFormat as NumberFormat,
    callerIdHeader: row.calleridHeader as CallerIdHeader,
    clir: row.clir === null ? null : row.clir === 1,
    codecs:
      row.codecsJson === null ? null : (JSON.parse(row.codecsJson) as Codec[]),
    maxChannels: row.maxChannels
  };
}

export function hostsToWire(hosts: TrunkHostRow[]): HostWire[] {
  return [...hosts]
    .sort((left, right) => left.priority - right.priority)
    .map(host => ({
      host: host.host,
      port: host.port,
      direction: host.direction as HostDirection
    }));
}

export function mapTrunkRow(
  row: TrunkRow,
  hosts: TrunkHostRow[],
  status: TrunkStatus
): TrunkWire {
  return {
    id: row.id,
    priority: row.priority,
    ...scalarsFromRow(row),
    hosts: hostsToWire(hosts),
    ...logLevelWire(row),
    status: status.status,
    statusChangedAt: status.statusChangedAt
  };
}
