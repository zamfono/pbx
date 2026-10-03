import {
  isRecord,
  MS_PER_SECOND,
  type Db,
  type OAuthClientKind
} from '@zamfono/shared';

import { attempt } from '../errors.js';
import { decrypt, encrypt, type Keyring } from '../secretbox.js';
import { TtlMap } from '../ttlMap.js';

// §5.2 "Client registration": the client-id-metadata-document fetch is cached in memory per the
// document's own Cache-Control max-age; a document without one is fetched every time.
const CACHE_CONTROL_MAX_AGE = /max-age=(?<seconds>\d+)/u;
const HTTPS_SCHEME = 'https://';
// RFC 8252 §7.3 (loopback IP literals) and §8.3 (`localhost`), as `URL.hostname` spells them.
const LOOPBACK_HOSTS: ReadonlySet<string> = new Set([
  '127.0.0.1',
  '[::1]',
  'localhost'
]);
const HTTP_SCHEME = 'http:';
// OpenID Connect Dynamic Client Registration §2: `application_type` defaults to `web`. The
// specification requires it only of `/oauth/register` (§5.2); a metadata document may omit it,
// as claude.ai's does.
const DEFAULT_APPLICATION_TYPE = 'web';

/** An OAuth client, however it registered (§5.2). */
export type ClientMeta = {
  clientId: string;
  kind: OAuthClientKind;
  name: string;
  redirectUris: string[];
  applicationType: 'native' | 'web';
};

const cimdCache = new TtlMap<string, ClientMeta>();

/** Encodes `meta` as a `client_id`: the JSON metadata, secretbox-encrypted and base64url'd. */
export function encodeMetadataClientId(
  kr: Keyring,
  meta: Omit<ClientMeta, 'clientId' | 'kind'>
): string {
  return encrypt(kr, JSON.stringify(meta)).toString('base64url');
}

/** Decodes a metadata `client_id`; `null` on a malformed blob or an unreadable key generation. */
export function decodeMetadataClientId(
  kr: Keyring,
  id: string
): ClientMeta | null {
  const plain = attempt(() => decrypt(kr, Buffer.from(id, 'base64url')));
  if (plain === undefined) {
    return null;
  }
  const parsed = attempt(() => JSON.parse(plain.toString('utf8')) as unknown);
  if (!isRecord(parsed)) {
    return null;
  }
  const { name, redirectUris, applicationType } = parsed;
  if (
    typeof name !== 'string' ||
    !Array.isArray(redirectUris) ||
    !redirectUris.every(uri => typeof uri === 'string') ||
    (applicationType !== 'native' && applicationType !== 'web')
  ) {
    return null;
  }
  return {
    clientId: id,
    kind: 'metadata',
    name,
    redirectUris,
    applicationType
  };
}

function cacheTtlMs(headers: Headers): number | null {
  const match = CACHE_CONTROL_MAX_AGE.exec(headers.get('cache-control') ?? '');
  const seconds = match?.groups?.seconds;
  return seconds === undefined ? null : Number(seconds) * MS_PER_SECOND;
}

function parseCimdDocument(
  clientIdUrl: string,
  body: unknown
): ClientMeta | null {
  if (!isRecord(body)) {
    return null;
  }
  const {
    client_id: docClientId,
    client_name: name,
    redirect_uris: redirectUris,
    application_type: applicationType = DEFAULT_APPLICATION_TYPE
  } = body;
  if (
    docClientId !== clientIdUrl ||
    typeof name !== 'string' ||
    !Array.isArray(redirectUris) ||
    !redirectUris.every(uri => typeof uri === 'string') ||
    (applicationType !== 'native' && applicationType !== 'web')
  ) {
    return null;
  }
  return {
    clientId: clientIdUrl,
    kind: 'cimd',
    name,
    redirectUris,
    applicationType
  };
}

/**
 * Fetches a Client ID Metadata Document over HTTPS (§5.2), refusing it unless its own
 * `client_id` equals the URL it was fetched from; caches the result per `Cache-Control`.
 */
export async function fetchCimd(
  clientIdUrl: string,
  fetchImpl: typeof fetch = fetch
): Promise<ClientMeta | null> {
  if (!clientIdUrl.startsWith(HTTPS_SCHEME)) {
    return null;
  }
  const cached = cimdCache.get(clientIdUrl);
  if (cached) {
    return cached;
  }
  const response = await fetchImpl(clientIdUrl);
  if (!response.ok) {
    return null;
  }
  const meta = parseCimdDocument(clientIdUrl, await response.json());
  if (!meta) {
    return null;
  }
  const ttlMs = cacheTtlMs(response.headers);
  if (ttlMs !== null) {
    cimdCache.set(clientIdUrl, meta, Date.now() + ttlMs);
  }
  return meta;
}

/** `uri` parsed as an `http` URI on a loopback host, or `null` for anything else. */
function loopbackUrl(uri: string): URL | null {
  const url = attempt(() => new URL(uri));
  return url?.protocol === HTTP_SCHEME && LOOPBACK_HOSTS.has(url.hostname)
    ? url
    : null;
}

/**
 * `uri` is an allowed redirect for `meta` (§5.2 "Client registration"): an exact match, or an
 * `http` loopback URI on any port that equals a registered loopback URI in every other part:
 * host, path and query, and userinfo and fragment, which neither should have. RFC 8252 §7.3:
 * the server "MUST allow any port to be specified at the time of the request for loopback IP
 * redirect URIs"; OAuth 2.1 §2.3.1 says the same, and RFC 8252 §8.3 allows `localhost` too. The
 * rule holds whatever the `application_type`: Claude Code's metadata document names none, so it
 * is a `web` client, and registers `http://localhost/callback` without a port. The host matches
 * as registered: `localhost` never stands for `127.0.0.1`, nor the reverse.
 */
export function redirectUriAllowed(meta: ClientMeta, uri: string): boolean {
  if (meta.redirectUris.includes(uri)) {
    return true;
  }
  const candidate = loopbackUrl(uri);
  if (candidate === null) {
    return false;
  }
  return meta.redirectUris.some(allowed => {
    const allowedUrl = loopbackUrl(allowed);
    if (allowedUrl === null) {
      return false;
    }
    const atRegisteredPort = new URL(candidate);
    atRegisteredPort.port = allowedUrl.port;
    return atRegisteredPort.href === allowedUrl.href;
  });
}

/** Upserts `oauth_clients` on a client's first successful authorization (§5.2, §11.2). */
export async function upsertClient(
  db: Db,
  meta: ClientMeta,
  now: string
): Promise<void> {
  await db
    .insertInto('oauthClients')
    .values({
      clientId: meta.clientId,
      name: meta.name,
      kind: meta.kind,
      redirectUrisJson: JSON.stringify(meta.redirectUris),
      createdAt: now,
      lastLoginAt: now
    })
    .onConflict(oc =>
      oc.column('clientId').doUpdateSet({
        name: meta.name,
        redirectUrisJson: JSON.stringify(meta.redirectUris),
        lastLoginAt: now
      })
    )
    .execute();
}
