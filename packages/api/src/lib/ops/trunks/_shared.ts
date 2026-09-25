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
  authMode: AuthMode;
  username: string | null;
  inboundAuth: boolean;
  transport: Transport;
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
    authMode: row.authMode as AuthMode,
    username: row.username,
    inboundAuth: row.inboundAuth === 1,
    transport: row.transport as Transport,
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
