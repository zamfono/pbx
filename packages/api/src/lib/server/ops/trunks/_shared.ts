import type { Selectable } from 'kysely';
import { z } from 'zod';

import {
  HOST_DIRECTIONS,
  MAX_PORT,
  type CallerIdHeader,
  type Db,
  type DB,
  type DiversionPolicy,
  type HostDirection,
  type LogLevelColumns,
  type NumberFormat,
  type TrunkAuthMode,
  type TrunkStatus,
  type TrunkTransport
} from '@zamfono/shared';

import { liveRow } from '../rows.js';
import { logLevelWire } from '../settings/logLevel.js';

/** The trunk offer codecs a client or trunk list may name (§9.1, §9.4); the image ships no others. */
export const CODECS = ['opus', 'g722', 'amrwb', 'amr', 'alaw', 'ulaw'] as const;
export type Codec = (typeof CODECS)[number];

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
    host: z
      .string()
      .min(1)
      .describe(
        'An FQDN or IPv4 address, or for an inbound host also an IPv6 address or a CIDR range; resolved through NAPTR and SRV unless a port is given.'
      ),
    port: z
      .number()
      .int()
      .min(1)
      .max(MAX_PORT)
      .nullable()
      .optional()
      .describe(
        'An explicit port, only where the provider requires one: it turns resolution into a plain A lookup.'
      ),
    direction: z
      .enum(HOST_DIRECTIONS)
      .optional()
      .describe(
        'both (default); outbound, dialled and registered to only; inbound, a source address the provider sends from, never dialled.'
      )
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
  authMode: TrunkAuthMode;
  username: string | null;
  inboundAuth: boolean;
  transport: TrunkTransport;
  /** `trunks.srtp`: SDES-SRTP media, `tls` trunks only (§9.4 "Signaling"). */
  srtp: boolean;
  /** `trunks.tls_verify`: the provider's certificate is checked; applies while `transport` is `tls`. */
  tlsVerify: boolean;
  /** `trunks.qualify`: an `ip` trunk's contact is OPTIONS-probed for its status; ignored for
   * `registration` (§9.4 "Provisioning and status"). */
  qualify: boolean;
  /** `trunks.diversion`: the `Diversion` a forwarded leg over the trunk carries, none, the newest
   * hop's or every hop's (§9.4 "Forwarded calls"). */
  diversion: DiversionPolicy;
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
    /** Whether a password is stored; the password itself is write-only (§10.3). */
    passwordSet: boolean;
    hosts: HostWire[];
    status: TrunkStatus['status'];
    statusChangedAt: string | null;
  };

export async function liveTrunk(db: Db, id: string): Promise<TrunkRow> {
  return liveRow(db, 'trunks', id, 'trunk not found');
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
    authMode: row.authMode,
    username: row.username,
    inboundAuth: row.inboundAuth === 1,
    transport: row.transport,
    srtp: row.srtp === 1,
    tlsVerify: row.tlsVerify === 1,
    qualify: row.qualify === 1,
    diversion: row.diversion,
    outboundProxy: row.outboundProxy,
    registerExpiryS: row.registerExpiryS,
    registerRetryS: row.registerRetryS,
    inboundNumberFormat: row.inboundNumberFormat,
    callerIdFormat: row.callerIdFormat,
    callerIdHeader: row.callerIdHeader,
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
      direction: host.direction
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
    passwordSet: row.passwordEnc !== null,
    hosts: hostsToWire(hosts),
    ...logLevelWire(row),
    status: status.status,
    statusChangedAt: status.statusChangedAt
  };
}
