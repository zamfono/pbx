/**
 * SIP trunks (`ops/trunks/`, admin, §9.4): the provider accounts calls leave and arrive through.
 * Every write runs the API's checks (`_writeChecks.ts`, `hostValidation.ts`, `_updateChecks.ts`):
 * credentials per auth mode, header layout, CLIR and forwarded caller ID, SRTP over TLS only, host
 * and outbound-proxy formats, the inbound-auth username as an endpoint name. The password is
 * write-only (`passwordSet`), and a write that sets or drops it cannot be undone. Status is live
 * state the core reports; `trunks.reregister` registers a registration trunk afresh.
 */
import { nowDate as demoNowDate } from '#lib/clock.svelte.js';

import { conflict, invalid, notFound, type BlockingRef } from '../../errors';
import { emit } from '../../events.svelte';
import { newId } from '../../ids';
import { allTargets } from '../../lookup';
import { store, touch } from '../../store.svelte';
import {
  CODECS,
  LOG_LEVEL_OVERRIDES,
  type ChangeEntry,
  type Codec,
  type Db,
  type LogLevelOverride,
  type OutboundRoute,
  type Trunk,
  type TrunkHost
} from '../../types';
import { defineOp, diff, type Ctx } from '../core';
import { softDeleteConfirm } from './dids';

export const AUTH_MODES = ['registration', 'ip'] as const;
export const TRANSPORTS = ['udp', 'tcp', 'tls'] as const;
export const HOST_DIRECTIONS = ['both', 'outbound', 'inbound'] as const;
export const NUMBER_FORMATS = ['e164', 'national'] as const;
export const CALLER_ID_HEADERS = ['from', 'pai', 'both'] as const;
export const DIVERSION_POLICIES = ['off', 'last', 'all'] as const;
export const FORWARDED_CALLER_IDS = [
  'own',
  'original',
  'originalPreferred'
] as const;

/**
 * The plain transports the demo deployment enables (`SIP_UDP_ENABLED`, `SIP_TCP_ENABLED`, §9.1);
 * `tls` is always available.
 */
export const PLAIN_TRANSPORTS_ENABLED: readonly Trunk['transport'][] = [
  'udp',
  'tcp'
];

const MAX_PORT = 65_535;
const MAX_TIMEOUT_S = 86_400;
/** Asterisk keeps a section name in 80 bytes, its NUL included (`MAX_SECTION_NAME_LENGTH`). */
const MAX_SECTION_NAME_LENGTH = 79;
const TRUNK_SECTION_PREFIX = 'trunk-';
const DEFAULT_OVERRIDE_DAYS_MS = 7 * 86_400_000;

/** How long the mock takes to unregister and register a trunk afresh, and to report a new one. */
export const REREGISTER_UNREGISTER_MS = 400;
export const REREGISTER_REGISTER_MS = 1800;
const FIRST_STATUS_MS = 2500;

export const SRV_DISABLED_WARNING = 'host has explicit port; SRV disabled';
export const NO_EMERGENCY_TRUNK_WARNING =
  'no emergency trunk; emergency calls will fail';

export type HostInput = {
  host: string;
  port?: number | null;
  direction?: TrunkHost['direction'];
};

/** The scalar fields `trunks.create` and `trunks.update` take, besides `name`, `hosts`, `password`. */
type TrunkFields = {
  emergency: boolean;
  authMode: Trunk['authMode'];
  username: string | null;
  inboundAuth: boolean;
  transport: Trunk['transport'];
  srtp: boolean;
  tlsVerify: boolean;
  qualify: boolean;
  diversion: Trunk['diversion'];
  forwardedCallerId: Trunk['forwardedCallerId'];
  outboundProxy: string | null;
  registerExpiryS: number | null;
  registerRetryS: number | null;
  inboundNumberFormat: Trunk['inboundNumberFormat'];
  callerIdFormat: Trunk['callerIdFormat'];
  callerIdHeader: Trunk['callerIdHeader'];
  clir: boolean | null;
  codecs: Codec[] | null;
  maxChannels: number | null;
};

export type TrunkCreateInput = Partial<
  Omit<TrunkFields, 'emergency' | 'authMode' | 'username'>
> & {
  name: string;
  emergency: boolean;
  authMode: Trunk['authMode'];
  username?: string;
  password?: string;
  hosts: HostInput[];
};

export type TrunkUpdateInput = Partial<TrunkFields> & {
  id: string;
  name?: string;
  password?: string | null;
  hosts?: HostInput[];
  logLevel?: LogLevelOverride | null;
  logLevelExpiresAt?: string | null;
};

export type TrunkWriteOutput = { trunk: Trunk; warnings: string[] };

/* ---------------- checks (`_writeChecks.ts`, `hostValidation.ts`) ---------------- */

const UNSAFE_HOST_PATTERN = /[\r\n[\]]/u;
const FQDN_PATTERN =
  /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/iu;
const IPV4_PATTERN =
  /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/u;
const SIP_URI_USER_PATTERN =
  /^(?:[A-Za-z0-9\-_.!~*'()&=+$,;?/]|%[0-9A-Fa-f]{2})+$/u;
const SIP_URI_PARAM_PATTERN = /^(?:lr|transport=(?:udp|tcp|tls))$/iu;
const SIP_URI_SCHEME_PATTERN = /^sips?:/iu;
// CR, LF or NUL anywhere, or a whitespace or control character at either end.
const LINE_ENDING_PATTERN = /[\r\n\0]/u;
const FIRST_UNSTRIPPED_CODE_POINT = 0x21;

const isIPv4 = (value: string): boolean => IPV4_PATTERN.test(value);

/** An IPv6 literal (the forms `node:net`'s `isIPv6` takes, without a zone). */
function isIPv6(value: string): boolean {
  if (!/^[0-9a-f:.]+$/iu.test(value) || !value.includes(':')) {
    return false;
  }
  const doubleColons = value.split('::').length - 1;
  if (doubleColons > 1) {
    return false;
  }
  const groups = value.split(':').filter(group => group !== '');
  const lastGroup = groups.at(-1) ?? '';
  const embeddedV4 = lastGroup.includes('.');
  if (embeddedV4 && !isIPv4(lastGroup)) {
    return false;
  }
  const hexGroups = embeddedV4 ? groups.slice(0, -1) : groups;
  if (hexGroups.some(group => !/^[0-9a-f]{1,4}$/iu.test(group))) {
    return false;
  }
  const width = hexGroups.length + (embeddedV4 ? 2 : 0);
  return doubleColons === 1 ? width < 8 : width === 8;
}

function isCidr(value: string): boolean {
  const [address = '', bits, ...rest] = value.split('/');
  if (bits === undefined || rest.length > 0 || !/^\d{1,3}$/u.test(bits)) {
    return false;
  }
  const prefix = Number(bits);
  if (isIPv4(address)) {
    return prefix <= 32;
  }
  return isIPv6(address) && prefix <= 128;
}

/** Whether `host` may be a trunk host with `direction` (`assertValidHost`). */
export function hostProblem(
  host: string,
  direction: TrunkHost['direction']
): 'unsafe' | 'invalid' | null {
  if (UNSAFE_HOST_PATTERN.test(host)) {
    return 'unsafe';
  }
  if (isIPv4(host) || FQDN_PATTERN.test(host)) {
    return null;
  }
  if (direction === 'inbound' && (isIPv6(host) || isCidr(host))) {
    return null;
  }
  return 'invalid';
}

/** Whether `value` is an outbound proxy PJSIP accepts (`isValidOutboundProxyUri`). */
export function isValidOutboundProxy(value: string): boolean {
  if (UNSAFE_HOST_PATTERN.test(value) || !SIP_URI_SCHEME_PATTERN.test(value)) {
    return false;
  }
  const [hostPort = '', ...params] = value
    .replace(SIP_URI_SCHEME_PATTERN, '')
    .split(';');
  if (params.some(param => !SIP_URI_PARAM_PATTERN.test(param))) {
    return false;
  }
  const colon = hostPort.indexOf(':');
  const host = colon === -1 ? hostPort : hostPort.slice(0, colon);
  const port = colon === -1 ? undefined : hostPort.slice(colon + 1);
  if (port !== undefined && !/^\d{1,5}$/u.test(port)) {
    return false;
  }
  return isIPv4(host) || FQDN_PATTERN.test(host);
}

function isWholeConfigValue(value: string): boolean {
  if (LINE_ENDING_PATTERN.test(value)) {
    return false;
  }
  const first = value.codePointAt(0) ?? FIRST_UNSTRIPPED_CODE_POINT;
  const last =
    value.codePointAt(value.length - 1) ?? FIRST_UNSTRIPPED_CODE_POINT;
  return (
    first >= FIRST_UNSTRIPPED_CODE_POINT && last >= FIRST_UNSTRIPPED_CODE_POINT
  );
}

function oneOf<T extends string>(
  field: string,
  value: unknown,
  allowed: readonly T[]
): T {
  if (
    typeof value !== 'string' ||
    !(allowed as readonly string[]).includes(value)
  ) {
    throw invalid(
      field,
      'trunks.invalidValue',
      `${field}: one of ${allowed.join(', ')}`,
      { field }
    );
  }
  return value as T;
}

function requireSeconds(field: string, value: number | null | undefined): void {
  if (value === null || value === undefined) {
    return;
  }
  if (!Number.isInteger(value) || value < 1 || value > MAX_TIMEOUT_S) {
    throw invalid(
      field,
      'trunks.secondsRange',
      `${field} must be 1–${MAX_TIMEOUT_S}`,
      { max: MAX_TIMEOUT_S }
    );
  }
}

/** The host list, each host checked and its defaults applied (`hostInputSchema`, `assertValidHosts`). */
function checkHosts(hosts: unknown): TrunkHost[] {
  if (!Array.isArray(hosts) || hosts.length === 0) {
    throw invalid('hosts', 'trunks.hostsRequired', 'hosts: at least one');
  }
  return (hosts as HostInput[]).map(input => {
    const host = typeof input.host === 'string' ? input.host.trim() : '';
    const direction = oneOf(
      'hosts',
      input.direction ?? 'both',
      HOST_DIRECTIONS
    );
    if (host === '') {
      throw invalid('hosts', 'trunks.hostRequired', 'host is required');
    }
    const problem = hostProblem(host, direction);
    if (problem === 'unsafe') {
      throw invalid(
        'hosts',
        'trunks.hostUnsafe',
        `host contains characters unsafe for generated config: ${host}`,
        { host }
      );
    }
    if (problem === 'invalid') {
      throw invalid(
        'hosts',
        direction === 'inbound'
          ? 'trunks.hostInvalidInbound'
          : 'trunks.hostInvalid',
        `invalid host: ${host}`,
        { host }
      );
    }
    const port = input.port ?? null;
    if (
      port !== null &&
      (!Number.isInteger(port) || port < 1 || port > MAX_PORT)
    ) {
      throw invalid('hosts', 'trunks.portRange', 'port must be 1–65535', {
        host
      });
    }
    return { host, port, direction };
  });
}

/** A registration trunk's registrar: its first `outbound` or `both` host (`assertHasRegistrar`). */
function assertHasRegistrar(
  authMode: Trunk['authMode'],
  hosts: TrunkHost[]
): void {
  if (
    authMode === 'registration' &&
    !hosts.some(host => host.direction !== 'inbound')
  ) {
    throw invalid(
      'hosts',
      'trunks.noRegistrar',
      'a registration trunk needs an outbound or both host, its registrar'
    );
  }
}

/** The checks every write's merged state passes (`assertUpdateAllowed`, create's equivalents). */
function assertConsistent(trunk: TrunkFields & { passwordSet: boolean }): void {
  if (trunk.srtp && trunk.transport !== 'tls') {
    throw invalid(
      'srtp',
      'trunks.srtpNeedsTls',
      "srtp requires transport 'tls'"
    );
  }
  if (trunk.clir === true && trunk.callerIdHeader === 'from') {
    throw invalid(
      'clir',
      'trunks.clirNeedsPai',
      "clir requires a 'pai' or 'both' callerIdHeader"
    );
  }
  if (trunk.forwardedCallerId !== 'own') {
    if (trunk.callerIdHeader !== 'from') {
      throw invalid(
        'forwardedCallerId',
        'trunks.forwardedNeedsFrom',
        "forwardedCallerId requires callerIdHeader 'from'"
      );
    }
    if (trunk.diversion === 'off') {
      throw invalid(
        'forwardedCallerId',
        'trunks.forwardedNeedsDiversion',
        "forwardedCallerId requires diversion 'last' or 'all'"
      );
    }
  }
  const required = trunk.authMode === 'registration' || trunk.inboundAuth;
  if (required && (trunk.username === null || !trunk.passwordSet)) {
    throw invalid(
      trunk.username === null ? 'username' : 'password',
      'trunks.credentialsRequired',
      'username and password are required for this auth mode'
    );
  }
  if (trunk.callerIdHeader === 'pai' && trunk.username === null) {
    throw invalid(
      'callerIdHeader',
      'trunks.paiNeedsUsername',
      "callerIdHeader 'pai' requires a username, the trunk's account identity"
    );
  }
}

function assertCredentialFields(
  username: string | null | undefined,
  password: string | null | undefined
): void {
  if (typeof username === 'string' && !SIP_URI_USER_PATTERN.test(username)) {
    throw invalid(
      'username',
      'trunks.usernameInvalid',
      'username holds a character no SIP URI user part takes',
      { username }
    );
  }
  if (typeof password === 'string' && !isWholeConfigValue(password)) {
    throw invalid(
      'password',
      'trunks.passwordInvalid',
      'password must hold no CR, LF or NUL, nor begin or end with whitespace'
    );
  }
}

function assertNameAvailable(db: Db, name: string, excludeId?: string): void {
  const clash = db.trunks.find(
    row =>
      row.deletedAt === null &&
      row.id !== excludeId &&
      row.name.toLowerCase() === name.toLowerCase()
  );
  if (clash !== undefined) {
    throw conflict('trunks.nameTaken', 'trunks: name already in use', [
      { kind: 'trunk', id: clash.id, label: clash.name }
    ]);
  }
}

/** An inbound-auth trunk's username names its own endpoint (`assertInboundAuthUsernameFree`). */
function assertInboundAuthUsernameFree(
  db: Db,
  username: string,
  excludeId?: string
): void {
  if (
    username.includes(';') ||
    username.length > MAX_SECTION_NAME_LENGTH ||
    username.startsWith(TRUNK_SECTION_PREFIX) ||
    username === 'anonymous'
  ) {
    throw invalid(
      'username',
      'trunks.inboundAuthUsername',
      `username cannot name an inbound-auth endpoint: ${username}`,
      {
        max: MAX_SECTION_NAME_LENGTH
      }
    );
  }
  const device = db.devices.find(
    row => row.deletedAt === null && row.sipUsername === username
  );
  const trunk = db.trunks.find(
    row =>
      row.deletedAt === null &&
      row.id !== excludeId &&
      row.inboundAuth &&
      row.username === username
  );
  if (device !== undefined || trunk !== undefined) {
    const ref: BlockingRef =
      device !== undefined
        ? { kind: 'device', id: device.id, label: device.label }
        : { kind: 'trunk', id: trunk?.id ?? '', label: trunk?.name ?? '' };
    throw conflict(
      'trunks.usernameTaken',
      'trunks: username already names a SIP endpoint',
      [ref]
    );
  }
}

function checkCodecs(codecs: unknown): Codec[] | null {
  if (codecs === null || codecs === undefined) {
    return null;
  }
  if (
    !Array.isArray(codecs) ||
    codecs.length === 0 ||
    codecs.some(codec => !(CODECS as readonly string[]).includes(String(codec)))
  ) {
    throw invalid(
      'codecs',
      'trunks.codecsInvalid',
      'codecs: a non-empty list of known codecs'
    );
  }
  return codecs as Codec[];
}

function checkMaxChannels(value: number | null | undefined): number | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (!Number.isInteger(value) || value < 1) {
    throw invalid(
      'maxChannels',
      'trunks.maxChannelsRange',
      'maxChannels must be a positive integer'
    );
  }
  return value;
}

function checkOutboundProxy(value: string | null | undefined): void {
  if (typeof value === 'string' && !isValidOutboundProxy(value)) {
    throw invalid(
      'outboundProxy',
      'trunks.outboundProxyInvalid',
      `invalid outbound proxy: ${value}`
    );
  }
}

/** Refuses a transport switched off by its `.env` flag (`assertTransportEnabled`). */
function assertTransportEnabled(transport: Trunk['transport']): void {
  if (transport !== 'tls' && !PLAIN_TRANSPORTS_ENABLED.includes(transport)) {
    throw invalid(
      'transport',
      'trunks.transportDisabled',
      `transport '${transport}' is disabled by this deployment`,
      {
        transport
      }
    );
  }
}

/* ---------------- warnings, references ---------------- */

const liveTrunks = (db: Db): Trunk[] =>
  db.trunks
    .filter(row => row.deletedAt === null)
    .sort((a, b) => a.priority - b.priority);

function emergencyWarnings(db: Db): string[] {
  return liveTrunks(db).some(trunk => trunk.emergency)
    ? []
    : [NO_EMERGENCY_TRUNK_WARNING];
}

const hostWarnings = (hosts: TrunkHost[]): string[] =>
  hosts.some(host => host.port !== null) ? [SRV_DISABLED_WARNING] : [];

/** What still dials over trunk `id` (`trunkReferences`): its routes and its `sip` targets' owners. */
export function trunkReferences(db: Db, id: string): BlockingRef[] {
  const routes = db.outboundRoutes
    .map((route, index) => ({ route, index }))
    .filter(({ route }) => route.trunkId === id)
    .map(({ route, index }) => ({
      kind: 'outboundRoute',
      id: route.id,
      label: `#${index + 1}`
    }));
  const owners = allTargets()
    .filter(entry => entry.target.kind === 'sip' && entry.target.trunkId === id)
    .map(entry => ({
      ...entry.owner,
      label:
        entry.owner.kind === 'settings'
          ? db.settings.companyName
          : entry.owner.label
    }));
  const seen = new Set<string>();
  return [...routes, ...owners].filter(ref => {
    const key = `${ref.kind}:${ref.id}:${ref.label}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

const liveTrunk = (db: Db, id: string): Trunk => {
  const row = db.trunks.find(
    candidate => candidate.id === id && candidate.deletedAt === null
  );
  if (row === undefined) {
    throw notFound('trunk', id);
  }
  return row;
};

/** The masked `password` change a write that stores or drops one records (`recordPasswordChange`). */
const PASSWORD_CHANGE: ChangeEntry = {
  field: 'password',
  from: '•••',
  to: '•••'
};

/* ---------------- operations ---------------- */

defineOp<Record<string, never>, { items: Trunk[] }>({
  name: 'trunks.list',
  minRole: 'admin',
  readOnly: true,
  run: ctx => ({ items: liveTrunks(ctx.db) })
});

defineOp<{ id: string }, Trunk>({
  name: 'trunks.get',
  minRole: 'admin',
  readOnly: true,
  run: (ctx, input) => liveTrunk(ctx.db, input.id)
});

defineOp<TrunkCreateInput, TrunkWriteOutput>({
  name: 'trunks.create',
  minRole: 'admin',
  run: (ctx, input) => {
    const name = typeof input.name === 'string' ? input.name.trim() : '';
    if (name === '') {
      throw invalid('name', 'trunks.nameRequired', 'name is required');
    }
    if (typeof input.emergency !== 'boolean') {
      throw invalid(
        'emergency',
        'trunks.emergencyRequired',
        'emergency is required'
      );
    }
    const authMode = oneOf('authMode', input.authMode, AUTH_MODES);
    const transport = oneOf('transport', input.transport ?? 'udp', TRANSPORTS);
    const callerIdHeader = oneOf(
      'callerIdHeader',
      input.callerIdHeader ?? 'from',
      CALLER_ID_HEADERS
    );
    const inboundAuth = input.inboundAuth === true;
    const required = authMode === 'registration' || inboundAuth;
    const username =
      input.username === undefined || input.username === ''
        ? undefined
        : input.username;
    const password =
      input.password === undefined || input.password === ''
        ? undefined
        : input.password;
    assertTransportEnabled(transport);
    if (!required && (username !== undefined || password !== undefined)) {
      throw invalid(
        'username',
        'trunks.credentialsNotAccepted',
        'username and password are only accepted for registration auth or inbound auth'
      );
    }
    if (
      authMode !== 'registration' &&
      (input.registerExpiryS != null || input.registerRetryS != null)
    ) {
      throw invalid(
        'registerExpiryS',
        'trunks.registrationOnly',
        'registerExpiryS and registerRetryS are only accepted for registration auth'
      );
    }
    const fields: TrunkFields & { passwordSet: boolean } = {
      emergency: input.emergency,
      authMode,
      username: required ? (username ?? null) : null,
      passwordSet: required && password !== undefined,
      inboundAuth,
      transport,
      srtp: input.srtp === true,
      tlsVerify: input.tlsVerify !== false,
      qualify: input.qualify !== false,
      diversion: oneOf(
        'diversion',
        input.diversion ?? 'off',
        DIVERSION_POLICIES
      ),
      forwardedCallerId: oneOf(
        'forwardedCallerId',
        input.forwardedCallerId ?? 'own',
        FORWARDED_CALLER_IDS
      ),
      outboundProxy: input.outboundProxy ?? null,
      registerExpiryS:
        authMode === 'registration' ? (input.registerExpiryS ?? null) : null,
      registerRetryS:
        authMode === 'registration' ? (input.registerRetryS ?? null) : null,
      inboundNumberFormat: oneOf(
        'inboundNumberFormat',
        input.inboundNumberFormat ?? 'e164',
        NUMBER_FORMATS
      ),
      callerIdFormat: oneOf(
        'callerIdFormat',
        input.callerIdFormat ?? 'e164',
        NUMBER_FORMATS
      ),
      callerIdHeader,
      clir: input.clir ?? null,
      codecs: checkCodecs(input.codecs),
      maxChannels: checkMaxChannels(input.maxChannels)
    };
    assertConsistent(fields);
    requireSeconds('registerExpiryS', fields.registerExpiryS);
    requireSeconds('registerRetryS', fields.registerRetryS);
    const hosts = checkHosts(input.hosts);
    assertHasRegistrar(authMode, hosts);
    checkOutboundProxy(fields.outboundProxy);
    assertCredentialFields(username, password);
    assertNameAvailable(ctx.db, name);
    if (inboundAuth && username !== undefined) {
      assertInboundAuthUsernameFree(ctx.db, username);
    }

    const live = liveTrunks(ctx.db);
    const trunk: Trunk = {
      id: newId(),
      name,
      ...fields,
      hosts,
      logLevel: null,
      logLevelExpiresAt: null,
      // Past every live trunk; `live.length` covers a seed row whose priority is below 1.
      priority:
        live.reduce((max, row) => Math.max(max, row.priority), live.length) + 1,
      status: authMode === 'ip' && !fields.qualify ? 'unmonitored' : 'unknown',
      statusChangedAt: null,
      registeredAt: null,
      createdAt: ctx.now,
      deletedAt: null
    };
    ctx.insert('trunks', trunk);
    if (live.length === 0) {
      // The first trunk brings the catch-all route: no callers, no numbers (§9.4).
      const catchAll: OutboundRoute = {
        id: newId(),
        trunkId: trunk.id,
        callerIdDidId: null,
        users: [],
        userGroups: [],
        numbers: []
      };
      ctx.setRoot('outboundRoutes', [catchAll]);
    }
    if (trunk.status === 'unknown') {
      // The core picks the new trunk up with the config reload and reports it once it answers.
      setTimeout(() => reportStatus(trunk.id, 'registered'), FIRST_STATUS_MS);
    }
    const credentials = username !== undefined || password !== undefined;
    ctx.audit({
      entityKind: 'trunk',
      entityId: trunk.id,
      changes: [
        ...diff(null, trunk),
        ...(credentials ? [PASSWORD_CHANGE] : [])
      ],
      undoable: !credentials
    });
    return {
      trunk,
      warnings: [...hostWarnings(hosts), ...emergencyWarnings(ctx.db)]
    };
  }
});

/** The override columns an update writes (`resolveLogLevel`), or the row's own. */
function resolveLogLevel(
  ctx: Ctx,
  row: Trunk,
  input: TrunkUpdateInput
): Pick<Trunk, 'logLevel' | 'logLevelExpiresAt'> {
  if (input.logLevel === undefined && input.logLevelExpiresAt === undefined) {
    return { logLevel: row.logLevel, logLevelExpiresAt: row.logLevelExpiresAt };
  }
  if (input.logLevel === null) {
    return { logLevel: null, logLevelExpiresAt: null };
  }
  const level = input.logLevel ?? row.logLevel;
  if (level === null) {
    throw invalid(
      'logLevelExpiresAt',
      'trunks.logLevelExpiry',
      'logLevelExpiresAt needs a logLevel to expire'
    );
  }
  oneOf('logLevel', level, LOG_LEVEL_OVERRIDES);
  return {
    logLevel: level,
    logLevelExpiresAt:
      input.logLevelExpiresAt ??
      new Date(Date.parse(ctx.now) + DEFAULT_OVERRIDE_DAYS_MS).toISOString()
  };
}

defineOp<TrunkUpdateInput, TrunkWriteOutput>({
  name: 'trunks.update',
  minRole: 'admin',
  run: (ctx, input) => {
    const row = liveTrunk(ctx.db, input.id);
    const name = input.name === undefined ? row.name : input.name.trim();
    if (name === '') {
      throw invalid('name', 'trunks.nameRequired', 'name is required');
    }
    const authMode =
      input.authMode === undefined
        ? row.authMode
        : oneOf('authMode', input.authMode, AUTH_MODES);
    const inboundAuth = input.inboundAuth ?? row.inboundAuth;
    const required = authMode === 'registration' || inboundAuth;
    const transport =
      input.transport === undefined
        ? row.transport
        : oneOf('transport', input.transport, TRANSPORTS);
    const orRow = <T>(
      value: T | null | undefined,
      current: T | null
    ): T | null => (value === undefined ? current : value);
    const passwordSet = required
      ? input.password === undefined
        ? row.passwordSet
        : input.password !== null
      : false;
    const merged: TrunkFields & { passwordSet: boolean } = {
      emergency: input.emergency ?? row.emergency,
      authMode,
      username: required ? orRow(input.username, row.username) : null,
      passwordSet,
      inboundAuth,
      transport,
      srtp: input.srtp ?? row.srtp,
      tlsVerify: input.tlsVerify ?? row.tlsVerify,
      qualify: input.qualify ?? row.qualify,
      diversion:
        input.diversion === undefined
          ? row.diversion
          : oneOf('diversion', input.diversion, DIVERSION_POLICIES),
      forwardedCallerId:
        input.forwardedCallerId === undefined
          ? row.forwardedCallerId
          : oneOf(
              'forwardedCallerId',
              input.forwardedCallerId,
              FORWARDED_CALLER_IDS
            ),
      outboundProxy: orRow(input.outboundProxy, row.outboundProxy),
      registerExpiryS:
        authMode === 'registration'
          ? orRow(input.registerExpiryS, row.registerExpiryS)
          : null,
      registerRetryS:
        authMode === 'registration'
          ? orRow(input.registerRetryS, row.registerRetryS)
          : null,
      inboundNumberFormat:
        input.inboundNumberFormat === undefined
          ? row.inboundNumberFormat
          : oneOf(
              'inboundNumberFormat',
              input.inboundNumberFormat,
              NUMBER_FORMATS
            ),
      callerIdFormat:
        input.callerIdFormat === undefined
          ? row.callerIdFormat
          : oneOf('callerIdFormat', input.callerIdFormat, NUMBER_FORMATS),
      callerIdHeader:
        input.callerIdHeader === undefined
          ? row.callerIdHeader
          : oneOf('callerIdHeader', input.callerIdHeader, CALLER_ID_HEADERS),
      clir: input.clir === undefined ? row.clir : input.clir,
      codecs:
        input.codecs === undefined ? row.codecs : checkCodecs(input.codecs),
      maxChannels:
        input.maxChannels === undefined
          ? row.maxChannels
          : checkMaxChannels(input.maxChannels)
    };

    // A trunk stays editable on a transport switched off since; only a write naming it is refused.
    if (input.transport !== undefined) {
      assertTransportEnabled(input.transport);
    }
    assertConsistent(merged);
    const usernameGiven =
      input.username !== undefined && input.username !== null;
    const passwordGiven =
      input.password !== undefined && input.password !== null;
    if (!required && (usernameGiven || passwordGiven)) {
      throw invalid(
        'username',
        'trunks.credentialsNotAccepted',
        'username and password are only accepted for registration auth or inbound auth'
      );
    }
    if (
      authMode !== 'registration' &&
      (input.registerExpiryS != null || input.registerRetryS != null)
    ) {
      throw invalid(
        'registerExpiryS',
        'trunks.registrationOnly',
        'registerExpiryS and registerRetryS are only accepted for registration auth'
      );
    }
    requireSeconds('registerExpiryS', input.registerExpiryS);
    requireSeconds('registerRetryS', input.registerRetryS);
    const hosts =
      input.hosts === undefined ? row.hosts : checkHosts(input.hosts);
    if (authMode === 'registration') {
      assertHasRegistrar(authMode, hosts);
    }
    if (input.outboundProxy !== undefined) {
      checkOutboundProxy(input.outboundProxy);
    }
    assertCredentialFields(input.username, input.password);
    if (input.name !== undefined) {
      assertNameAvailable(ctx.db, name, row.id);
    }
    if (merged.inboundAuth && merged.username !== null) {
      assertInboundAuthUsernameFree(ctx.db, merged.username, row.id);
    }
    const logLevel = resolveLogLevel(ctx, row, input);

    const status: Pick<Trunk, 'status' | 'statusChangedAt'> =
      merged.authMode === 'ip' && !merged.qualify
        ? {
            status: 'unmonitored',
            statusChangedAt:
              row.status === 'unmonitored' ? row.statusChangedAt : ctx.now
          }
        : { status: row.status, statusChangedAt: row.statusChangedAt };
    const updated: Trunk = {
      ...row,
      ...merged,
      name,
      hosts,
      ...logLevel,
      ...status
    };
    ctx.put('trunks', updated);
    const passwordChanged =
      typeof input.password === 'string' ||
      (row.passwordSet && !updated.passwordSet);
    ctx.audit({
      entityKind: 'trunk',
      entityId: row.id,
      changes: [
        ...diff(
          { ...row, status: undefined, statusChangedAt: undefined },
          { ...updated, status: undefined, statusChangedAt: undefined }
        ),
        ...(passwordChanged ? [PASSWORD_CHANGE] : [])
      ],
      undoable: !passwordChanged
    });
    return {
      trunk: updated,
      warnings: [
        ...(input.hosts === undefined ? [] : hostWarnings(hosts)),
        ...emergencyWarnings(ctx.db)
      ]
    };
  }
});

defineOp<{ id: string }, { id: string; warnings: string[] }>({
  name: 'trunks.delete',
  minRole: 'admin',
  confirm: (ctx, input) =>
    softDeleteConfirm(ctx.db, 'trunks.delete', {
      name: liveTrunk(ctx.db, input.id).name
    }),
  run: (ctx, input) => {
    const row = liveTrunk(ctx.db, input.id);
    const references = trunkReferences(ctx.db, row.id);
    if (references.length > 0) {
      throw conflict(
        'trunks.inUse',
        'trunk is used by outbound routes or sip forward targets',
        references
      );
    }
    const before = { ...row };
    ctx.softDelete('trunks', row.id);
    ctx.audit({
      entityKind: 'trunk',
      entityId: row.id,
      before,
      after: { ...before, deletedAt: ctx.now }
    });
    return { id: row.id, warnings: emergencyWarnings(ctx.db) };
  }
});

defineOp<{ trunkIds: string[] }, { trunkIds: string[] }>({
  name: 'trunks.setOrder',
  minRole: 'admin',
  run: (ctx, input) => {
    const live = liveTrunks(ctx.db);
    const ids = Array.isArray(input.trunkIds) ? input.trunkIds : [];
    const named = new Set(ids);
    const everyLiveTrunkNamed =
      named.size === ids.length &&
      named.size === live.length &&
      live.every(trunk => named.has(trunk.id));
    if (!everyLiveTrunkNamed) {
      throw invalid(
        'trunkIds',
        'trunks.orderMismatch',
        'trunkIds must name every live trunk exactly once'
      );
    }
    const previous = live.map(trunk => trunk.id);
    ids.forEach((id, index) => {
      const trunk = live.find(row => row.id === id);
      if (trunk !== undefined && trunk.priority !== index + 1) {
        ctx.put('trunks', { ...trunk, priority: index + 1 });
      }
    });
    ctx.audit({
      entityKind: 'trunk',
      entityId: null,
      changes: [{ field: 'trunkIds', from: previous, to: ids }]
    });
    return { trunkIds: ids };
  }
});

/** Sets the live status the core would report for `id`, outside any operation (it is not stored). */
function reportStatus(id: string, status: Trunk['status']): void {
  const trunk = store.db.trunks.find(
    row => row.id === id && row.deletedAt === null
  );
  if (trunk === undefined) {
    return;
  }
  const now = demoNowDate().toISOString();
  if (trunk.status !== status) {
    trunk.status = status;
    trunk.statusChangedAt = now;
    emit({ type: 'trunk.status', trunkId: id, status });
  }
  if (status === 'registered') {
    trunk.registeredAt = now;
  }
  touch();
}

defineOp<{ id: string }, { id: string }>({
  name: 'trunks.reregister',
  minRole: 'admin',
  run: (ctx, input) => {
    const trunk = liveTrunk(ctx.db, input.id);
    if (trunk.authMode !== 'registration') {
      throw conflict('trunks.noRegistration', 'trunk has no registration');
    }
    ctx.audit({
      entityKind: 'trunk',
      entityId: trunk.id,
      changes: [],
      pure: true
    });
    // Asterisk unregisters first (the trunk reads unreachable), then registers over a fresh
    // transaction; status and registeredAt show the outcome (§9.4 "Provisioning and status").
    setTimeout(
      () => reportStatus(trunk.id, 'unreachable'),
      REREGISTER_UNREGISTER_MS
    );
    setTimeout(
      () => reportStatus(trunk.id, 'registered'),
      REREGISTER_REGISTER_MS
    );
    return { id: trunk.id };
  }
});
