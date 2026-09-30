/**
 * `core`'s boot environment (§6.3 "Environment"): every variable the process reads, parsed and
 * validated once at start so a malformed value fails the boot instead of a later call.
 */

// Asterisk mounts ARI under `/ari` on its HTTP server, and `http.conf` sets no `prefix`
// (`images/asterisk/conf/http.conf.tmpl`), so the base URL carries the prefix: `AriClient` appends
// `/events` and resolves every REST path against it without inserting one.
const DEFAULT_ARI_URL = 'http://asterisk:8088/ari';
const DEFAULT_AMI_HOST = 'asterisk:5038';
const DEFAULT_DB_FILE = '/data/zamfono.sqlite3';
const DEFAULT_MEDIA_DIR = '/media';
const DEFAULT_CALL_LOG_MAX_BYTES = 1048576;
const DEFAULT_TZ = 'UTC';
const MIN_PORT = 1;
const MAX_PORT = 65535;

export type CoreEnv = {
  ariUrl: string;
  ariPassword: string;
  amiHost: string;
  amiPort: number;
  amiPassword: string;
  dbFile: string;
  mediaDir: string;
  hepEnabled: boolean;
  callLogMaxBytes: number;
  tz: string;
  /** The address the stack writes into SIP (§6.1, §9.1): `EXTERNAL_IPV4` in the ports mode, else
   * `STACK_IPV4`, which the transports bind in the macvlan mode; `null` while neither is set. */
  sipHost: string | null;
};

function requireEnv(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (value === undefined || value === '') {
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

/** `TZ`, throwing on an explicitly empty value; unset falls back to `DEFAULT_TZ`. */
function parseTz(raw: string | undefined): string {
  if (raw === '') {
    throw new Error('TZ: expected a non-empty value');
  }
  return raw ?? DEFAULT_TZ;
}

/** `EXTERNAL_IPV4`, else `STACK_IPV4`, the Asterisk entrypoint's order; `null` for neither. */
function parseSipHost(env: NodeJS.ProcessEnv): string | null {
  // An empty value is unset: compose.yaml hands both to `core` as `${…:-}`.
  for (const value of [env.EXTERNAL_IPV4, env.STACK_IPV4]) {
    if (value !== undefined && value !== '') {
      return value;
    }
  }
  return null;
}

// amiHost's port, callLogMaxBytes and tz are validated here and carried on `CoreEnv` for the
// call pipeline, the OOO/hours sweep and the HEP listener; tz is the tenant clock while
// `settings.timezone` is NULL (§11.4). hepEnabled accepts any value other than the literal
// string 'false' as true.
export function readEnv(env: NodeJS.ProcessEnv): CoreEnv {
  const ami = parseHostPort(env.AMI_HOST ?? DEFAULT_AMI_HOST);
  return {
    ariUrl: env.ARI_URL ?? DEFAULT_ARI_URL,
    ariPassword: requireEnv(env, 'ARI_PASSWORD'),
    amiHost: ami.host,
    amiPort: ami.port,
    amiPassword: requireEnv(env, 'AMI_PASSWORD'),
    dbFile: env.DB_FILE ?? DEFAULT_DB_FILE,
    mediaDir: env.MEDIA_DIR ?? DEFAULT_MEDIA_DIR,
    hepEnabled: env.HEP_ENABLED !== 'false',
    callLogMaxBytes: parseCallLogMaxBytes(env.CALL_LOG_MAX_BYTES),
    tz: parseTz(env.TZ),
    sipHost: parseSipHost(env)
  };
}
