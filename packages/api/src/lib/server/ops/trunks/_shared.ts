import type { Selectable } from 'kysely';
import { z } from 'zod';

import {
  CALLERID_HEADERS,
  codecsColumn,
  codecsSchema,
  DIVERSION_POLICIES,
  HOST_DIRECTIONS,
  MAX_PORT,
  NUMBER_FORMATS,
  TRUNK_AUTH_MODES,
  TRUNK_TRANSPORTS,
  type Db,
  type DB,
  type HostDirection,
  type TrunkStatus
} from '@zamfono/shared';

import { liveRow } from '../rows.js';
import { logLevelOutputFields, logLevelWire } from '../settings/logLevel.js';

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

export const hostWire = z.object({
  host: z.string(),
  port: z.number().nullable(),
  direction: z.enum(HOST_DIRECTIONS)
});
export type HostWire = z.infer<typeof hostWire>;

/** The scalar (non-host, non-status) fields of a trunk, in their wire shape (§9.4, §10.3). */
export const trunkScalars = z.object({
  name: z.string(),
  emergency: z
    .boolean()
    .describe(
      'Only these trunks carry emergency calls (§9.4 "Emergency trunks").'
    ),
  authMode: z.enum(TRUNK_AUTH_MODES),
  username: z.string().nullable(),
  inboundAuth: z.boolean(),
  transport: z.enum(TRUNK_TRANSPORTS),
  srtp: z.boolean().describe('SDES-SRTP media, tls trunks only.'),
  tlsVerify: z
    .boolean()
    .describe(
      "The provider's certificate is checked; applies while transport is tls."
    ),
  qualify: z
    .boolean()
    .describe(
      "An ip trunk's contact is OPTIONS-probed for its status; ignored for registration."
    ),
  diversion: z
    .enum(DIVERSION_POLICIES)
    .describe(
      "The Diversion a forwarded leg over the trunk carries: none, the newest hop's or every hop's."
    ),
  outboundProxy: z.string().nullable(),
  registerExpiryS: z.number().nullable(),
  registerRetryS: z.number().nullable(),
  inboundNumberFormat: z.enum(NUMBER_FORMATS),
  callerIdFormat: z.enum(NUMBER_FORMATS),
  callerIdHeader: z.enum(CALLERID_HEADERS),
  clir: z.boolean().nullable(),
  codecs: codecsSchema.nullable(),
  maxChannels: z.number().nullable()
});
export type TrunkScalars = z.infer<typeof trunkScalars>;

const TRUNK_STATUSES = [
  'registered',
  'unreachable',
  'unmonitored',
  'unknown'
] as const;

export const trunkWire = trunkScalars.extend({
  id: z.string(),
  priority: z.number(),
  passwordSet: z
    .boolean()
    .describe(
      'Whether a password is stored; the password itself is write-only.'
    ),
  hosts: z.array(hostWire),
  ...logLevelOutputFields,
  status: z.enum(TRUNK_STATUSES),
  statusChangedAt: z.string().nullable(),
  registeredAt: z
    .string()
    .nullable()
    .describe(
      'When the last REGISTER succeeded, a refresh included; null for an ip trunk and until core sees one succeed after its connection to Asterisk opened.'
    )
});
export type TrunkWire = z.infer<typeof trunkWire>;

/** A trunk write's answer: the trunk, and what it leaves the emergency set without (§9.4). */
export const trunkWriteOutput = z.object({
  trunk: trunkWire,
  warnings: z.array(z.string())
});

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
    codecs: codecsColumn.nullable().decode(row.codecsJson),
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
    statusChangedAt: status.statusChangedAt,
    registeredAt: status.registeredAt
  };
}
