/**
 * A `registration` trunk's outbound `REGISTER` (§9.4 "Auth mode", "Flows"), the one section of
 * `pjsip_trunks.conf` only that auth mode carries.
 */
import { registrationUris, trunkSectionName } from '@zamfono/shared';

import {
  escapeConfigValue,
  hostsByDirection,
  outboundProxyLines,
  trunkTransport,
  type Trunk
} from './shared.js';
import { UnrenderableValueError } from './skippedRows.js';

// Asterisk's own `retry_interval` default, which a trunk without `register_retry_s` keeps.
const DEFAULT_RETRY_S = 60;
// `max_retries` has no "unlimited"; its largest value retries every interval for longer than any
// deployment lives.
const UNLIMITED_RETRIES = 4_294_967_295;

/**
 * The retry policy of §9.4 "Auth mode" ("retries every `register_retry_s`") and "Hosts"
 * (failover is re-registration): PJSIP's defaults give up for good after 10 failed attempts, on
 * the first 403 (`forbidden_retry_interval = 0`), on any other fatal response
 * (`fatal_retry_interval = 0`) and on a rejected challenge (`auth_rejection_permanent`), each
 * until the next reload. Every failure retries at the trunk's interval instead, indefinitely.
 */
function retryLines(trunk: Trunk): string[] {
  const retryS = trunk.registerRetryS ?? DEFAULT_RETRY_S;
  const lines =
    trunk.registerRetryS === null ? [] : [`retry_interval = ${retryS}`];
  return [
    ...lines,
    `forbidden_retry_interval = ${retryS}`,
    `fatal_retry_interval = ${retryS}`,
    `max_retries = ${UNLIMITED_RETRIES}`,
    'auth_rejection_permanent = no'
  ];
}

/**
 * Outbound registration to the registrar: the highest-priority `outbound`/`both` host (§9.4
 * "Flows"). An `inbound`-only host is a media-gateway address the trunk is never dialed at
 * and never registers to (§9.4 "Hosts"), so it is excluded here exactly as in `renderTrunkAor`.
 * The registered contact's user part is the account name (`contact_user`, Asterisk's default
 * `s` otherwise), so an INVITE the provider addresses to that contact delivers the account name
 * as its called party, which a DID of that `number` serves (§9.4 "Inbound number normalization").
 */
export function renderTrunkRegistration(trunk: Trunk): string | null {
  if (trunk.authMode !== 'registration' || trunk.username === null) {
    return null;
  }
  const name = trunkSectionName(trunk.id);
  const registrars = hostsByDirection(trunk, ['outbound', 'both']);
  if (registrars.length === 0) {
    throw new UnrenderableValueError('trunk.hosts');
  }
  const { clientUri, serverUri } = registrationUris({
    username: trunk.username,
    hosts: registrars
  });
  const lines = [
    `[${name}]`,
    'type = registration',
    `transport = ${trunkTransport(trunk)}`,
    `outbound_auth = ${name}`,
    `client_uri = ${escapeConfigValue(clientUri)}`,
    `server_uri = ${serverUri}`,
    `contact_user = ${escapeConfigValue(trunk.username)}`,
    'line = yes',
    'support_outbound = yes'
  ];
  if (trunk.registerExpiryS !== null) {
    lines.push(`expiration = ${trunk.registerExpiryS}`);
  }
  lines.push(...retryLines(trunk));
  lines.push(...outboundProxyLines(trunk));
  lines.push(`endpoint = ${name}`);
  return lines.join('\n');
}
