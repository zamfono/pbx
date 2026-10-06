// Types and helpers common to the users and trunks renderers (`render.ts`, `trunks.ts`), kept
// in their own module so neither renderer depends on the other.

import type {
  CallerIdHeader,
  DeviceKind,
  DeviceTransport,
  HostDirection,
  TrunkAuthMode,
  TrunkTransport
} from '@zamfono/shared';

import { UnrenderableValueError } from './skippedRows.js';

export type RenderInput = {
  // holdMohClass: the MoH class a party hears while a device holds them (§10.2 "Hold music"):
  // the class of `settings.hold_moh_audio_id`, else Asterisk's static `default`.
  settings: {
    codecs: string[];
    ringotelMaxRegs: number;
    extLength: number;
    holdMohClass: string;
  };
  // name: the display name a device's calls carry as caller-ID name (§11.2 `users.name`).
  // ringGroupIds: the ring groups the user belongs to (§5.3), so a device AOR can list
  // every group mailbox the user reads.
  users: { id: string; ext: string; name: string; ringGroupIds: string[] }[];
  devices: {
    id: string;
    userId: string;
    kind: DeviceKind;
    transport: DeviceTransport;
    allowedIps: string[] | null;
    sipUsername: string;
    sipPassword: string;
  }[];
  ringGroups: { id: string; ext: string }[];
  parkingSlots: string[];
  trunks: {
    id: string;
    name: string;
    authMode: TrunkAuthMode;
    username: string | null;
    password: string | null;
    inboundAuth: boolean;
    transport: TrunkTransport;
    srtp: boolean;
    tlsVerify: boolean;
    qualify: boolean;
    outboundProxy: string | null;
    registerExpiryS: number | null;
    registerRetryS: number | null;
    callerIdHeader: CallerIdHeader;
    codecs: string[] | null;
    hosts: {
      priority: number;
      host: string;
      port: number | null;
      direction: HostDirection;
    }[];
  }[];
  moh: { id: string; filename: string }[];
};

export type Rendered = {
  'pjsip_users.conf': string;
  'pjsip_trunks.conf': string;
  'extensions_hints.conf': string;
  'musiconhold.conf': string;
};

export type Device = RenderInput['devices'][number];
export type Trunk = RenderInput['trunks'][number];
export type TrunkHost = Trunk['hosts'][number];

// An extension is dialplan-safe digits only (§9.3); it is interpolated into hint lines and
// endpoint contexts, so a value that fails this check is refused rather than written out.
const EXTENSION_PATTERN = /^[0-9]+$/u;

// Ids, hostnames, proxies and usernames are interpolated into the generated config, some as
// section names; a CR/LF or a bracket could open a new PJSIP section, such as the `[anonymous]`
// endpoint §5.6 forbids, so any such value is refused rather than written out.
const UNSAFE_CONFIG_PATTERN = /[\r\n[\]]/u;

// A value Asterisk's config parser (main/config.c) cannot read back whole from `<key> = <value>`:
// a CR or LF ends its line, and a NUL ends it as a C string. A bracket opens a section only at the
// start of a line, a `;` is escaped (`escapeConfigValue`) and the line splits at its first `=`, so
// every other character reads back as written.
const LINE_ENDING_PATTERN = /[\r\n\0]/u;

// The parser strips every character below this code point (space and the control characters,
// `ast_strip`) from both ends of a value, and has no quoting or escape that keeps them.
const FIRST_UNSTRIPPED_CODE_POINT = 0x21;

// Server-generated ids (`newId()`, §11.1) are UUIDv7: hex digits and hyphens only. A moh
// asset id is interpolated into a filesystem path, where the injection check above still
// admits `/` and `..`, so that id is checked against this stricter shape instead.
const ID_PATTERN = /^[0-9a-z-]+$/iu;

/** Throws when `ext` is not dialplan-safe digits (§9.3), since it is written into config verbatim. */
export function assertExtension(ext: string, field: string): void {
  if (!EXTENSION_PATTERN.test(ext)) {
    throw new UnrenderableValueError(field);
  }
}

/** Throws when `value` could break out of its PJSIP line or section. */
export function assertSafeConfigValue(value: string, field: string): void {
  if (UNSAFE_CONFIG_PATTERN.test(value)) {
    throw new UnrenderableValueError(field);
  }
}

/** Whether `value` begins or ends with a character Asterisk's config parser strips away. */
export function hasStrippedEnd(value: string): boolean {
  const first = value.codePointAt(0) ?? FIRST_UNSTRIPPED_CODE_POINT;
  const last =
    value.codePointAt(value.length - 1) ?? FIRST_UNSTRIPPED_CODE_POINT;
  return (
    first < FIRST_UNSTRIPPED_CODE_POINT || last < FIRST_UNSTRIPPED_CODE_POINT
  );
}

/** Whether `value`, escaped by `escapeConfigValue`, reads back from `<key> = <value>` as written. */
export function isWholeConfigValue(value: string): boolean {
  return !LINE_ENDING_PATTERN.test(value) && !hasStrippedEnd(value);
}

/** Throws when `value` would not read back from its line as written (`isWholeConfigValue`). */
export function assertWholeConfigValue(value: string, field: string): void {
  if (!isWholeConfigValue(value)) {
    throw new UnrenderableValueError(field);
  }
}

/**
 * `value` with every `;` written as `\;`. Asterisk's config parser (main/config.c) cuts a line
 * at its first `;`, since that starts a comment, and keeps a `;` only when a backslash precedes
 * it, removing that one backslash and nothing else; so a password `ab;cd` is read as `ab` unless
 * escaped, and a backslash elsewhere in the value is read back unchanged.
 */
export function escapeConfigValue(value: string): string {
  return value.replaceAll(';', '\\;');
}

/** Throws when `id` is not a bare UUIDv7 shape, since it becomes a filesystem path segment. */
export function assertSafeId(id: string, field: string): void {
  if (!ID_PATTERN.test(id)) {
    throw new UnrenderableValueError(field);
  }
}

/** Fixed-locale string comparator, so sort order never depends on the runtime locale. */
export function compareStrings(left: string, right: string): number {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
}

export function formatAllow(codecs: string[]): string {
  return `allow = !all,${codecs.join(',')}`;
}

/**
 * The PJSIP transport a trunk's endpoint and registration name (§9.1, §9.4 "Signaling"). PJSIP
 * checks a server certificate per transport, not per endpoint, so a `tls` trunk that does not
 * check its provider's certificate uses `transport-tls-noverify`, the second TLS transport, and
 * every other `tls` trunk the checking `transport-tls` the devices connect to.
 */
export function trunkTransport(trunk: Trunk): string {
  if (trunk.transport === 'tls' && !trunk.tlsVerify) {
    return 'transport-tls-noverify';
  }
  return `transport-${trunk.transport}`;
}

/**
 * The `outbound_proxy` line of a trunk's aor, endpoint and registration, when it has a proxy.
 * PJSIP sends the URI as a `Route`; one without `;lr` would be strict-routed (RFC 3261 §16.12),
 * the proxy's URI replacing the Request-URI, so `;lr` is added where the stored URI lacks it.
 */
export function outboundProxyLines(trunk: Trunk): string[] {
  if (trunk.outboundProxy === null) {
    return [];
  }
  const params = trunk.outboundProxy.split(';').slice(1);
  const uri = params.some(param => param.toLowerCase() === 'lr')
    ? trunk.outboundProxy
    : `${trunk.outboundProxy};lr`;
  return [`outbound_proxy = ${escapeConfigValue(uri)}`];
}

export function hostsByDirection(
  trunk: Trunk,
  directions: readonly TrunkHost['direction'][]
): TrunkHost[] {
  return trunk.hosts
    .filter(host => directions.includes(host.direction))
    .sort((left, right) => left.priority - right.priority);
}

export function joinSections(sections: string[]): string {
  return `${sections.join('\n\n')}\n`;
}
