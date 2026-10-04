/**
 * `core`'s boot environment (§6.3 "Environment"): every variable the process reads, parsed and
 * validated once at start so a malformed value fails the boot instead of a later call. Only the
 * secrets and the public address are required; every other variable has its default here, and an
 * empty value, which Compose hands over for an unset `${VAR:-}`, counts as unset.
 */
import {
  DEFAULT_DB_FILE,
  DEFAULT_MEDIA_DIR,
  MAX_PORT,
  resolveVersion,
  stackTimeZoneError,
  type ZamfonoVersion
} from '@zamfono/shared';

// Asterisk mounts ARI under `/ari` on its HTTP server, and `http.conf` sets no `prefix`
// (`images/asterisk/conf/http.conf.tmpl`), so the base URL carries the prefix: `AriClient` appends
// `/events` and resolves every REST path against it without inserting one.
const DEFAULT_ARI_URL = 'http://asterisk:8088/ari';
const DEFAULT_AMI_HOST = 'asterisk:5038';
const DEFAULT_CALL_LOG_MAX_BYTES = 1048576;
const DEFAULT_TZ = 'UTC';
const DEFAULT_API_INTERNAL_URL = 'http://api:3000';
const MIN_PORT = 1;

export type CoreEnv = {
  ariUrl: string;
  ariPassword: string;
  amiHost: string;
  amiPort: number;
  amiPassword: string;
  dbFile: string;
  mediaDir: string;
  hepEnabled: boolean;
  /** `SIP_UDP_ENABLED` and `SIP_TCP_ENABLED` (§9.1): whether the plain SIP transports serve trunks. */
  sipUdpEnabled: boolean;
  sipTcpEnabled: boolean;
  callLogMaxBytes: number;
  tz: string;
  /** What `core` logs once at start about a `TZ` that names no IANA time zone, else `undefined`. */
  timeZoneError: string | undefined;
  /** `STACK_IPV4` and `EXTERNAL_IPV4`, `null` while unset, which one of them is in each mode: the
   * addresses the HEP collector counts as Asterisk's own, besides the `ariUrl` host's (§7). */
  stackIpv4: string | null;
  externalIpv4: string | null;
  /** The address the stack writes into SIP (§6.1, §9.1): `EXTERNAL_IPV4` in the ports mode, else
   * `STACK_IPV4`, which the transports bind in the macvlan mode. */
  sipHost: string;
  /** `api`'s internal HTTP API, where `core` posts its mail requests (§3.1 "Mail"). */
  apiInternalUrl: string;
  /** `ZAMFONO_VERSION` and `ZAMFONO_REVISION` (§7 "Version"). */
  version: ZamfonoVersion;
};

/** The value of `name`, `undefined` while unset or empty. */
function optionalEnv(env: NodeJS.ProcessEnv, name: string): string | undefined {
  return env[name] === '' ? undefined : env[name];
}

function requireEnv(env: NodeJS.ProcessEnv, name: string): string {
  const value = optionalEnv(env, name);
  if (value === undefined) {
    throw new Error(`missing required environment variable ${name}`);
  }
  return value;
}

/** Parses a TCP port, throwing with `context` on anything outside 1-65535. */
function parsePort(raw: string, context: string): number {
  const port = Number(raw);
  if (!Number.isInteger(port) || port < MIN_PORT || port > MAX_PORT) {
    throw new Error(
      `${context}: expected a port between ${MIN_PORT} and ${MAX_PORT}, got '${raw}'`
    );
  }
  return port;
}

/** Splits `AMI_HOST` (`host:port`, e.g. `asterisk:5038`) into its parts. */
function parseHostPort(value: string): { host: string; port: number } {
  const separatorIndex = value.lastIndexOf(':');
  if (separatorIndex === -1) {
    throw new Error(`expected host:port, got '${value}'`);
  }
  return {
    host: value.slice(0, separatorIndex),
    port: parsePort(value.slice(separatorIndex + 1), 'AMI_HOST')
  };
}

/** `CALL_LOG_MAX_BYTES`, throwing on anything that is not a positive integer. */
function parseCallLogMaxBytes(raw: string | undefined): number {
  const value = Number(raw ?? DEFAULT_CALL_LOG_MAX_BYTES);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(
      `CALL_LOG_MAX_BYTES: expected a positive integer, got '${raw ?? ''}'`
    );
  }
  return value;
}

// amiHost's port, callLogMaxBytes and tz are validated here and carried on `CoreEnv` for the
// call pipeline, the OOO/hours sweep and the HEP listener; tz is the tenant clock while
// `settings.timezone` is NULL (§11.4). hepEnabled accepts any value other than the literal
// string 'false' as true, as do sipUdpEnabled and sipTcpEnabled.
export function readEnv(env: NodeJS.ProcessEnv): CoreEnv {
  const ami = parseHostPort(optionalEnv(env, 'AMI_HOST') ?? DEFAULT_AMI_HOST);
  const stackIpv4 = optionalEnv(env, 'STACK_IPV4') ?? null;
  const externalIpv4 = optionalEnv(env, 'EXTERNAL_IPV4') ?? null;
  const tz = optionalEnv(env, 'TZ') ?? DEFAULT_TZ;
  // The Asterisk entrypoint's order; the mode's overlay requires one of them (§6.1).
  const sipHost = externalIpv4 ?? stackIpv4;
  if (sipHost === null) {
    throw new Error(
      'missing required environment variable EXTERNAL_IPV4 or STACK_IPV4'
    );
  }
  return {
    ariUrl: optionalEnv(env, 'ARI_URL') ?? DEFAULT_ARI_URL,
    ariPassword: requireEnv(env, 'ARI_PASSWORD'),
    amiHost: ami.host,
    amiPort: ami.port,
    amiPassword: requireEnv(env, 'AMI_PASSWORD'),
    dbFile: optionalEnv(env, 'DB_FILE') ?? DEFAULT_DB_FILE,
    mediaDir: optionalEnv(env, 'MEDIA_DIR') ?? DEFAULT_MEDIA_DIR,
    hepEnabled: env.HEP_ENABLED !== 'false',
    sipUdpEnabled: env.SIP_UDP_ENABLED !== 'false',
    sipTcpEnabled: env.SIP_TCP_ENABLED !== 'false',
    callLogMaxBytes: parseCallLogMaxBytes(
      optionalEnv(env, 'CALL_LOG_MAX_BYTES')
    ),
    tz,
    timeZoneError: stackTimeZoneError(tz),
    stackIpv4,
    externalIpv4,
    sipHost,
    apiInternalUrl:
      optionalEnv(env, 'API_INTERNAL_URL') ?? DEFAULT_API_INTERNAL_URL,
    version: resolveVersion(env)
  };
}
