import * as env from '$app/env/private';

import {
  HTTP_CONFLICT,
  HTTP_UNPROCESSABLE_CONTENT,
  TRUNK_SECTION_PREFIX,
  type Db
} from '@zamfono/shared';

import { plainSipTransports } from '#lib/server/stackAddress.js';

import { OpError } from '../types.js';
import {
  hasEmergencyTrunk,
  type CallerIdHeader,
  type HostInput,
  type Transport
} from './_shared.js';

/** Throws 422 when `transport` is switched off by its `.env` flag (§9.1, §9.4 "Signaling"). */
export function assertTransportEnabled(transport: Transport): void {
  if (transport !== 'tls' && !plainSipTransports(env).includes(transport)) {
    throw new OpError(
      HTTP_UNPROCESSABLE_CONTENT,
      `transport '${transport}' is disabled by this deployment`
    );
  }
}

/**
 * Throws 422 for `srtp` on a trunk whose transport is not `tls`, mirroring the `trunks` CHECK
 * constraint of §11.2: SDES carries the media keys in the SDP, which only TLS keeps private
 * (§9.4 "Signaling").
 */
export function assertSrtpNeedsTls(srtp: boolean, transport: Transport): void {
  if (srtp && transport !== 'tls') {
    throw new OpError(
      HTTP_UNPROCESSABLE_CONTENT,
      "srtp requires transport 'tls'"
    );
  }
}

/** Throws 422 for `clir = true` on a trunk whose header layout carries no PAI (§9.4 "Anonymous calls"). */
export function assertClirAllowed(
  clir: boolean | null,
  callerIdHeader: CallerIdHeader
): void {
  if (clir === true && callerIdHeader === 'from') {
    throw new OpError(
      HTTP_UNPROCESSABLE_CONTENT,
      "clir requires a 'pai' or 'both' callerIdHeader"
    );
  }
}

/**
 * Throws 422 for a `pai` header layout on a trunk without a `username`: `pai` puts the trunk's
 * account identity in `From`, and that identity is its `username` (§9.4 "Caller ID").
 */
export function assertPaiHasIdentity(
  callerIdHeader: CallerIdHeader,
  username: string | null
): void {
  if (callerIdHeader === 'pai' && username === null) {
    throw new OpError(
      HTTP_UNPROCESSABLE_CONTENT,
      "callerIdHeader 'pai' requires a username, the trunk's account identity"
    );
  }
}

/**
 * Throws 422 when username/password presence does not match whether they are required, mirroring
 * the `trunks` CHECK constraint of §11.2: required for `registration` auth or `inboundAuth`, else
 * refused.
 */
export function assertCredentialsConsistency(
  required: boolean,
  usernamePresent: boolean,
  passwordPresent: boolean
): void {
  if (required && !(usernamePresent && passwordPresent)) {
    throw new OpError(
      HTTP_UNPROCESSABLE_CONTENT,
      'username and password are required for this auth mode'
    );
  }
  if (!required && (usernamePresent || passwordPresent)) {
    throw new OpError(
      HTTP_UNPROCESSABLE_CONTENT,
      'username and password are only accepted for registration auth or inbound auth'
    );
  }
}

/** Throws 409 when `name` is already used by another live trunk (`trunks.name` partial UNIQUE, §11.2). */
export async function assertNameAvailable(
  db: Db,
  name: string,
  excludeId?: string
): Promise<void> {
  let query = db
    .selectFrom('trunks')
    .select('id')
    .where('name', '=', name)
    .where('deletedAt', 'is', null);
  if (excludeId !== undefined) {
    query = query.where('id', '!=', excludeId);
  }
  const existing = await query.executeTakeFirst();
  if (existing) {
    throw new OpError(HTTP_CONFLICT, `trunk name already in use: ${name}`);
  }
}

/**
 * Throws when an `inbound_auth` trunk's `username` cannot name its own endpoint. Asterisk's
 * `identify_by = auth_username` looks the Authorization username up as an endpoint's name (§9.4
 * "Inbound identification"), so the trunk's inbound endpoint is a section named by the username:
 * 422 for a `;`, which a section header cannot carry, or the `trunk-` prefix every trunk's own
 * endpoint uses; 409 when a live device or another live `inbound_auth` trunk already holds it.
 */
export async function assertInboundAuthUsernameFree(
  db: Db,
  username: string,
  excludeId?: string
): Promise<void> {
  if (username.includes(';') || username.startsWith(TRUNK_SECTION_PREFIX)) {
    throw new OpError(
      HTTP_UNPROCESSABLE_CONTENT,
      `username cannot name an inbound-auth endpoint: ${username}`
    );
  }
  let trunks = db
    .selectFrom('trunks')
    .select('id')
    .where('username', '=', username)
    .where('inboundAuth', '=', 1)
    .where('deletedAt', 'is', null);
  if (excludeId !== undefined) {
    trunks = trunks.where('id', '!=', excludeId);
  }
  const device = await db
    .selectFrom('devices')
    .select('id')
    .where('sipUsername', '=', username)
    .where('deletedAt', 'is', null)
    .executeTakeFirst();
  if (device !== undefined || (await trunks.executeTakeFirst()) !== undefined) {
    throw new OpError(
      HTTP_CONFLICT,
      `username already names a SIP endpoint: ${username}`
    );
  }
}

const SRV_DISABLED_WARNING = 'host has explicit port; SRV disabled';

/** One warning when any of `hosts` carries an explicit port, since SRV resolution is then skipped (§9.4 "Hosts"). */
export function hostWarnings(hosts: HostInput[]): string[] {
  return hosts.some(host => typeof host.port === 'number')
    ? [SRV_DISABLED_WARNING]
    : [];
}

export const NO_EMERGENCY_TRUNK_WARNING =
  'no emergency trunk; emergency calls will fail';

/**
 * One warning when the write just made leaves no live trunk with `trunks.emergency` set, since
 * emergency calls then fail (§9.4 "Emergency trunks", §10.1 "Emergency calls"). Read after the
 * write, so it reports the state the write left behind, whatever that state was before.
 */
export async function emergencyTrunkWarnings(db: Db): Promise<string[]> {
  return (await hasEmergencyTrunk(db)) ? [] : [NO_EMERGENCY_TRUNK_WARNING];
}
