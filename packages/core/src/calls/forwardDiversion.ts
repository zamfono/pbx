/**
 * The `Diversion` a forwarded trunk leg carries under its trunk's `trunks.diversion` (§9.4
 * "Forwarded calls", RFC 5806): the number each hop names, the party's own and never an
 * extension, and the header the core writes itself, chan_pjsip's own being off on every trunk
 * endpoint (`send_diversion = no`). Applied beside the leg's other headers by
 * `forwardContext.ts`'s `forwardVariables`.
 */
import { isE164, type DiversionPolicy } from '@zamfono/shared';

import { userById, type Snapshot } from '../internal/snapshot.js';
import { formatCallerId } from '../routing/trunk.js';
import type { Call } from './call.js';
import type {
  Diversion,
  DivertingParty,
  RedirectingReason
} from './forwardContext.js';
import { cutUtf8 } from './forwardHeaders.js';
import { outboundHosts } from './trunkStatus.js';

/** The `reason` RFC 5806 §4 names for each hop's `REDIRECTING` reason. */
const DIVERSION_REASONS = {
  away: 'away',
  time_of_day: 'time-of-day',
  cfu: 'unconditional',
  cfb: 'user-busy',
  cfnr: 'no-answer',
  unavailable: 'unavailable',
  dnd: 'do-not-disturb'
} as const satisfies Record<RedirectingReason, string>;

// A display name's cut, as `{{forwardedByName}}`'s (§9.4 "Header templates").
const NAME_MAX_BYTES = 64;

// CR, LF, tab and the rest of C0, DEL and C1: nothing that could end the header or reshape it.
const CONTROL = /\p{Cc}/gu;

/** A live DID's number by id, `null` for none or a deleted one. */
function didNumber(snapshot: Snapshot, didId: string | null): string | null {
  if (didId === null) {
    return null;
  }
  const did = snapshot.dids.find(row => row.id === didId);
  return did?.number ?? null;
}

/** A ring group's DID: of the DIDs in the international form whose target is the group, the one
 * created first. */
function ringGroupDid(snapshot: Snapshot, ringGroupId: string): string | null {
  const targets = new Set(
    snapshot.forwardTargets
      .filter(row => row.ringGroupId === ringGroupId)
      .map(row => row.id)
  );
  const dids = snapshot.dids
    .filter(row => targets.has(row.targetId) && isE164(row.number))
    .sort(
      (left, right) =>
        left.createdAt.localeCompare(right.createdAt) ||
        left.id.localeCompare(right.id)
    );
  return dids.at(0)?.number ?? null;
}

/** `party`'s own number, before the main number stands in for it: a user's primary number, a
 * ring group's DID, a menu's called number of an inbound call in the international form. */
function partyDid(
  snapshot: Snapshot,
  call: Call,
  party: DivertingParty
): string | null {
  if ('userId' in party) {
    const user = userById(snapshot, party.userId);
    return didNumber(snapshot, user?.callerIdDidId ?? null);
  }
  if ('ringGroupId' in party) {
    return ringGroupDid(snapshot, party.ringGroupId);
  }
  return call.direction === 'inbound' && isE164(call.to) ? call.to : null;
}

/**
 * The number a hop from `party` names in its `Diversion` entry (§9.4 "Forwarded calls"): the
 * party's own, else the tenant's main number, never an extension; `null` with neither, a main DID
 * since deleted, which leaves the hop out of the header.
 */
export function diversionNumber(
  snapshot: Snapshot,
  call: Call,
  party: DivertingParty
): string | null {
  return (
    partyDid(snapshot, call, party) ??
    didNumber(snapshot, snapshot.settings.mainDidId)
  );
}

/** What a trunk's legs make of their hops: its policy, the host its entries name and the format
 * its numbers take. */
export type DiversionTrunk = {
  policy: DiversionPolicy;
  host: string | null;
  format: 'e164' | 'national';
  country: string;
};

/**
 * `trunk`'s `Diversion` settings. The host is chan_pjsip's own `Diversion`'s, the leg's `From`
 * host, where the core can know it: a `pai` trunk's `from_domain`, its first outbound host; else
 * the address the stack writes into SIP (`stackSipHost`, `EXTERNAL_IPV4` else `STACK_IPV4`).
 */
export function diversionTrunk(
  trunk: Snapshot['trunks'][number],
  snapshot: Snapshot,
  stackSipHost: string
): DiversionTrunk {
  const firstHost = outboundHosts(snapshot, trunk.id).at(0)?.host ?? null;
  const host =
    trunk.callerIdHeader === 'pai' && trunk.username !== null
      ? firstHost
      : stackSipHost;
  return {
    policy: trunk.diversion,
    host,
    format: trunk.callerIdFormat,
    country: snapshot.settings.country
  };
}

/** A hop's display name as an RFC 3261 quoted-string: control characters stripped, `"` and `\`
 * escaped, cut to 64 bytes first. */
function quotedName(name: string): string {
  const cut = cutUtf8(name.replaceAll(CONTROL, '').trim(), NAME_MAX_BYTES);
  return `"${cut.replaceAll(/["\\]/gu, char => `\\${char}`)}"`;
}

/** One hop's entry, `"<name>" <sip:<number>@<host>>;reason=<reason>`, without a `counter`,
 * which counts 1 when absent (RFC 5806 §9.2.4). */
function diversionEntry(
  hop: Diversion,
  number: string,
  trunk: DiversionTrunk & { host: string }
): string {
  const uri = `<sip:${formatCallerId(number, trunk.format, trunk.country)}@${trunk.host}>`;
  const name =
    hop.name === null || hop.name.trim() === '' ? '' : quotedName(hop.name);
  return `${name === '' ? '' : `${name} `}${uri};reason=${DIVERSION_REASONS[hop.reason]}`;
}

/**
 * The `Diversion` value a leg `diversions` (first hop first) led to sends over `trunk`, `null`
 * for none: `off` sends none, `last` the newest hop, `all` every hop, newest first as RFC 5806 §4
 * orders them. One header field with comma-separated entries, RFC 5806 §4's `1#` list, which RFC
 * 3261 §7.3.1 makes equivalent to a field per entry and which one originate variable can carry.
 * A hop without a number is left out before the policy picks.
 */
export function diversionHeader(
  diversions: Diversion[],
  trunk: DiversionTrunk
): string | null {
  const { host } = trunk;
  if (trunk.policy === 'off' || host === null) {
    return null;
  }
  const entries = diversions
    .toReversed()
    .flatMap(hop =>
      hop.diversionNumber === null
        ? []
        : [diversionEntry(hop, hop.diversionNumber, { ...trunk, host })]
    );
  const sent = trunk.policy === 'last' ? entries.slice(0, 1) : entries;
  return sent.length === 0 ? null : sent.join(', ');
}
