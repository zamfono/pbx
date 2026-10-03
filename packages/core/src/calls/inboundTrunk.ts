/**
 * The trunk boundary of an inbound call (§9.4 "Inbound number normalization"): which trunk the
 * call arrived on, read from its channel's PJSIP endpoint, and the called and calling numbers
 * normalized with that trunk's `inbound_number_format` under the tenant's country.
 */
import {
  ANONYMOUS,
  isInboundNumber,
  normalizeInbound,
  trunkSectionName,
  type NumberFormat
} from '@zamfono/shared';

import type { AriClient } from '../ari/client.js';
import type { Channel } from '../ari/types.js';
import type { Snapshot } from '../internal/snapshot.js';

/** `trunks.inbound_number_format`'s column default, for a call no trunk row accounts for. */
const DEFAULT_FORMAT: NumberFormat = 'e164';

type InboundBoundary = {
  /** The trunk that identified the call, or `null` when no trunk row matches its endpoint. */
  trunkId: string | null;
  called: string;
  /** Whether `called` came from the `To` header rather than the Request-URI (`calledParty`). */
  calledFromTo: boolean;
  from: string;
};

/** The RFC 3323 privacy values that suppress the caller's identity: `id` its asserted identity
 * (RFC 3325), `header` the headers that carry it, `user` the `From` the caller already
 * anonymised. `none`, `session` and `critical` suppress no identity. */
const IDENTITY_PRIVACY = new Set(['id', 'header', 'user']);

/** User parts that name no number: RFC 3323's `anonymous`, and the words providers send in its
 * place for a withheld or unavailable caller. Compared without regard to case. */
const NO_NUMBER_USERS = new Set([
  ANONYMOUS,
  'restricted',
  'private',
  'withheld',
  'unavailable',
  'unknown'
]);

/**
 * Whether the caller is withheld (§9.4 "Withheld caller"): "a `From` without a usable user part,
 * or an identity suppressed under RFC 3323 privacy". A user part is unusable when absent or a
 * word that names no number; any other non-numeric user part passes the boundary verbatim
 * (§9.4 "Inbound number normalization": "Anything else passes the boundary verbatim").
 */
function callerWithheld(number: string, privacy: string | null): boolean {
  const suppressed = (privacy ?? '')
    .split(/[;,]/u)
    .some(value => IDENTITY_PRIVACY.has(value.trim().toLowerCase()));
  const user = number.trim().toLowerCase();
  return suppressed || user === '' || NO_NUMBER_USERS.has(user);
}

/** chan_pjsip's channel name, `PJSIP/<endpoint>-<8 hex digits of sequence>`. */
const PJSIP_CHANNEL_NAME = /^PJSIP\/(?<endpoint>.+)-[0-9a-f]{8}$/u;

/**
 * The trunk whose endpoint carries `channel`, read from its chan_pjsip name. A trunk's endpoint
 * is its section `trunk-<id>` (§9.4 "Provisioning and status"); a call an `inbound_auth` trunk's
 * digest credential identified arrives on the endpoint named by that username instead, since
 * `identify_by = auth_username` finds the endpoint by that name (§9.4 "Inbound identification").
 */
export function inboundTrunk(
  channel: Channel,
  snapshot: Snapshot
): Snapshot['trunks'][number] | null {
  const endpoint = PJSIP_CHANNEL_NAME.exec(channel.name)?.groups?.endpoint;
  if (endpoint === undefined) {
    return null;
  }
  return (
    snapshot.trunks.find(row => trunkSectionName(row.id) === endpoint) ??
    snapshot.trunks.find(
      row => row.inboundAuth === 1 && row.username === endpoint
    ) ??
    null
  );
}

/**
 * Both parties normalized at the trunk boundary; a withheld caller is `anonymous` (§9.4
 * "Withheld caller"). The request's `Privacy` header is read off the channel: chan_pjsip exposes
 * it to no caller-ID field unless the endpoint trusts inbound identity, and then only alongside
 * a `P-Asserted-Identity`.
 */
// A SIP URI's user part in a header value, `+498995409700` in
// `<sip:+498995409700@46.224.111.67:5060;user=phone>`.
const URI_USER = /sips?:(?<user>[^@;>]+)@/iu;

/**
 * The called party as the provider meant it (§9.4 "Inbound number normalization"): the
 * Request-URI's user part, unless that is no number and the `To` header's is. A registration
 * trunk's provider addresses the INVITE to the contact the stack registered, whose user part is
 * the account name, and carries the dialled number in `To` alone; one whose `To` names the
 * account too keeps the verbatim account name, which a `dids` row of that name matches.
 */
async function calledParty(
  ari: AriClient,
  channel: Channel,
  requestUriUser: string
): Promise<{ called: string; fromTo: boolean }> {
  if (isInboundNumber(requestUriUser)) {
    return { called: requestUriUser, fromTo: false };
  }
  const to = await ari.channels.getVariable(
    channel.id,
    'PJSIP_HEADER(read,To)'
  );
  const user = URI_USER.exec(to ?? '')?.groups?.user;
  const decoded = user === undefined ? undefined : decodeURIComponent(user);
  return decoded !== undefined && isInboundNumber(decoded)
    ? { called: decoded, fromTo: true }
    : { called: requestUriUser, fromTo: false };
}

export async function inboundBoundary(
  ari: AriClient,
  channel: Channel,
  calledRaw: string,
  snapshot: Snapshot
): Promise<InboundBoundary> {
  const privacy = await ari.channels.getVariable(
    channel.id,
    'PJSIP_HEADER(read,Privacy)'
  );
  const trunk = inboundTrunk(channel, snapshot);
  const format = trunk ? trunk.inboundNumberFormat : DEFAULT_FORMAT;
  const country = snapshot.settings.country;
  const { called, fromTo } = await calledParty(ari, channel, calledRaw);
  return {
    trunkId: trunk?.id ?? null,
    calledFromTo: fromTo,
    called: normalizeInbound(called, format, country),
    from: callerWithheld(channel.caller.number, privacy)
      ? ANONYMOUS
      : normalizeInbound(channel.caller.number, format, country)
  };
}
