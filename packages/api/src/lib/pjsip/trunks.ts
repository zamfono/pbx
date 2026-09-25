import {
  assertSafeConfigValue,
  compareStrings,
  escapeConfigValue,
  formatAllow,
  formatHostUri,
  hostsByDirection,
  joinSections,
  trunkSectionName,
  type RenderInput,
  type Trunk,
  type TrunkHost
} from './shared.js';
import { renderTrunkRegistration } from './trunkRegistration.js';

// PJSIP OPTIONS-probes an `ip` trunk's static contact at this interval, so its reachability
// reaches `ContactStatusChange` events and, through them, the trunk's `qualify` status (§9.4).
const TRUNK_QUALIFY_FREQUENCY_S = 60;

function assertSafeTrunk(trunk: Trunk): void {
  assertSafeConfigValue(trunk.id, 'trunk.id');
  if (trunk.username !== null) {
    assertSafeConfigValue(trunk.username, 'trunk.username');
  }
  if (trunk.password !== null) {
    assertSafeConfigValue(trunk.password, 'trunk.password');
  }
  if (trunk.outboundProxy !== null) {
    assertSafeConfigValue(trunk.outboundProxy, 'trunk.outboundProxy');
  }
  for (const host of trunk.hosts) {
    assertSafeConfigValue(host.host, 'trunk.hosts.host');
  }
}

/**
 * Whether the trunk needs its own `auth` section: `registration` always answers outbound
 * challenges with it, and either mode answers an inbound challenge with it under
 * `inboundAuth` (§9.4 "Auth mode", "Inbound identification"). An `ip` trunk with stored
 * credentials but `inboundAuth` unset gets neither, since nothing challenges it (§9.4 "Auth
 * mode": "credentials pass only where `inbound_auth` is set").
 */
function trunkNeedsAuthSection(trunk: Trunk): boolean {
  return (
    trunk.username !== null &&
    trunk.password !== null &&
    (trunk.authMode === 'registration' || trunk.inboundAuth)
  );
}

/** Credentials, present for `registration` and whenever `inboundAuth` needs a challenge answer. */
function renderTrunkAuth(trunk: Trunk): string | null {
  const { username, password } = trunk;
  if (username === null || password === null || !trunkNeedsAuthSection(trunk)) {
    return null;
  }
  const name = trunkSectionName(trunk);
  return [
    `[${name}]`,
    'type = auth',
    'auth_type = userpass',
    `username = ${escapeConfigValue(username)}`,
    `password = ${escapeConfigValue(password)}`
  ].join('\n');
}

/**
 * The outbound target: the highest-priority `outbound`/`both` host, when the trunk has one.
 * `ip` trunks additionally OPTIONS-probe it so their status has a `ContactStatusChange` to
 * report (§9.4 "Provisioning and status"); `registration` trunks get their status from AMI
 * `Registry` events instead (§9.4), so no qualify is needed on their static contact.
 */
function renderTrunkAor(trunk: Trunk): string {
  const name = trunkSectionName(trunk);
  const lines = [`[${name}]`, 'type = aor'];
  const outboundHosts = hostsByDirection(trunk, ['outbound', 'both']);
  const [firstOutboundHost] = outboundHosts;
  if (firstOutboundHost !== undefined) {
    lines.push(`contact = ${formatHostUri(firstOutboundHost)}`);
  }
  if (trunk.authMode === 'ip') {
    lines.push(`qualify_frequency = ${TRUNK_QUALIFY_FREQUENCY_S}`);
  }
  if (trunk.outboundProxy !== null) {
    lines.push(`outbound_proxy = ${escapeConfigValue(trunk.outboundProxy)}`);
  }
  return lines.join('\n');
}

// The trunk's `inbound`/`both` hosts, in priority order: the set an `identify` section
// matches on (§9.4 "Inbound identification").
function trunkIdentifyHosts(trunk: Trunk): TrunkHost[] {
  return hostsByDirection(trunk, ['inbound', 'both']);
}

// Source-address identification (§9.4): the primary match for an `ip` trunk, the fallback
// for a `registration` trunk; `srv_lookups = yes` resolves a port-less FQDN host by SRV.
function renderTrunkIdentify(trunk: Trunk): string | null {
  const hosts = trunkIdentifyHosts(trunk);
  if (hosts.length === 0) {
    return null;
  }
  const name = trunkSectionName(trunk);
  return [
    `[${name}]`,
    'type = identify',
    `endpoint = ${name}`,
    ...hosts.map(host => `match = ${host.host}`),
    'srv_lookups = yes'
  ].join('\n');
}

/**
 * The header layout of `trunks.callerid_header` (§9.4 "Caller-ID", "Anonymous calls (CLIR)"),
 * which the core leaves to chan_pjsip: it presents the attempt's number as the channel's caller
 * ID, which `From` carries. `send_pai` adds a `P-Asserted-Identity` of that number for `pai` and
 * `both`, and `trust_id_outbound` keeps it there when the number is withheld. A `pai` trunk's
 * `From` is the account identity instead: `from_user` replaces the number with the trunk's
 * username, `from_domain` puts the registrar (for an `ip` trunk, the first outbound host) where
 * the stack's own address would be, and the asserted number takes that domain too.
 */
function callerIdLines(trunk: Trunk): string[] {
  if (trunk.callerIdHeader === 'from') {
    return [];
  }
  const lines = ['send_pai = yes', 'trust_id_outbound = yes'];
  if (trunk.callerIdHeader === 'pai' && trunk.username !== null) {
    const registrar = hostsByDirection(trunk, ['outbound', 'both']).at(0);
    lines.push(`from_user = ${escapeConfigValue(trunk.username)}`);
    if (registrar !== undefined) {
      lines.push(`from_domain = ${registrar.host}`);
    }
  }
  return lines;
}

// `outbound_auth` answers a digest challenge whenever the trunk has its own auth section; `auth`
// is added for `inboundAuth`, so a call its host list identifies is challenged too (§9.4
// "Inbound identification"). `identify_by = ip` leaves the endpoint only the mechanisms §5.6
// names: its `identify` section's source addresses, and the registration's `line` tag, which
// PJSIP matches whatever `identify_by` says; the digest match is the username endpoint's
// (`renderTrunkAuthEndpoint`). PJSIP's default, `username,ip`, would also hand the trunk any
// request whose `From` user is `trunk-<id>`, from any address.
function renderTrunkEndpoint(trunk: Trunk, tenantCodecs: string[]): string {
  const name = trunkSectionName(trunk);
  const codecs = trunk.codecs ?? tenantCodecs;
  const lines = [
    `[${name}]`,
    'type = endpoint',
    'context = from-trunk',
    formatAllow(codecs),
    `aors = ${name}`,
    `transport = transport-${trunk.transport}`,
    'direct_media = no'
  ];
  if (trunk.outboundProxy !== null) {
    lines.push(`outbound_proxy = ${escapeConfigValue(trunk.outboundProxy)}`);
  }
  if (trunkNeedsAuthSection(trunk)) {
    lines.push(`outbound_auth = ${name}`);
  }
  if (trunk.inboundAuth) {
    lines.push(`auth = ${name}`);
  }
  lines.push('identify_by = ip');
  lines.push(...callerIdLines(trunk));
  return lines.join('\n');
}

/**
 * The endpoint an `inboundAuth` trunk's digest credential identifies (§9.4 "Inbound
 * identification", `identify_by = auth_username`). Asterisk looks the Authorization username up
 * as an endpoint's *name*, so this second endpoint of the trunk is named by its username, where
 * the trunk's own `trunk-<id>` endpoint could never match; it carries the same `auth` section and
 * delivers into the same context. The operations layer keeps the name free (`trunks.create`).
 */
function renderTrunkAuthEndpoint(
  trunk: Trunk,
  tenantCodecs: string[]
): string | null {
  if (!trunk.inboundAuth || trunk.username === null) {
    return null;
  }
  if (trunk.username.includes(';')) {
    throw new Error('render: an inbound-auth username cannot carry a `;`');
  }
  return [
    `[${trunk.username}]`,
    'type = endpoint',
    'context = from-trunk',
    formatAllow(trunk.codecs ?? tenantCodecs),
    `transport = transport-${trunk.transport}`,
    'direct_media = no',
    `auth = ${trunkSectionName(trunk)}`,
    'identify_by = auth_username'
  ].join('\n');
}

export function renderTrunksConf(input: RenderInput): string {
  const trunks = [...input.trunks].sort((left, right) =>
    compareStrings(left.name, right.name)
  );
  const sections = trunks.flatMap(trunk => {
    assertSafeTrunk(trunk);
    return [
      renderTrunkAuth(trunk),
      renderTrunkAor(trunk),
      renderTrunkIdentify(trunk),
      renderTrunkRegistration(trunk),
      renderTrunkEndpoint(trunk, input.settings.codecs),
      renderTrunkAuthEndpoint(trunk, input.settings.codecs)
    ].filter((section): section is string => section !== null);
  });
  return joinSections(sections);
}
