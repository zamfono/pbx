import { MS_PER_SECOND, type Db } from '@zamfono/shared';

import { decrypt, encrypt, type Keyring } from '../secretbox.js';

// §5.2 "Client registration": the client-id-metadata-document fetch is cached in memory per the
// document's own Cache-Control max-age; a document without one is fetched every time.
const CACHE_CONTROL_MAX_AGE = /max-age=(?<seconds>\d+)/u;
const HTTPS_SCHEME = 'https://';
const LOOPBACK_HOST = '127.0.0.1';
const HTTP_SCHEME = 'http:';
// OpenID Connect Dynamic Client Registration §2: `application_type` defaults to `web`. The
// specification requires it only of `/oauth/register` (§5.2); a metadata document may omit it,
// as claude.ai's does.
const DEFAULT_APPLICATION_TYPE = 'web';

/** An OAuth client, however it registered (§5.2). */
export type ClientMeta = {
  clientId: string;
  kind: 'metadata' | 'cimd';
  name: string;
  redirectUris: string[];
  applicationType: 'native' | 'web';
};

type CacheEntry = { meta: ClientMeta; expiresAtMs: number };

const cimdCache = new Map<string, CacheEntry>();

/** `fn()`, or `undefined` when it throws. */
function attempt<T>(fn: () => T): T | undefined {
  try {
    return fn();
  } catch {
    return undefined;
  }
}

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
  if (parsed === undefined || typeof parsed !== 'object' || parsed === null) {
    return null;
  }
  const { name, redirectUris, applicationType } = parsed as Record<
    string,
    unknown
  >;
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
  if (typeof body !== 'object' || body === null) {
    return null;
  }
  const doc = body as Record<string, unknown>;
  const {
    client_id: docClientId,
    client_name: name,
    redirect_uris: redirectUris,
    application_type: applicationType = DEFAULT_APPLICATION_TYPE
  } = doc;
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
  if (cached && cached.expiresAtMs > Date.now()) {
    return cached.meta;
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
    cimdCache.set(clientIdUrl, { meta, expiresAtMs: Date.now() + ttlMs });
  }
  return meta;
}

/**
 * `uri` is an allowed redirect for `meta`: an exact match, or, for a `native` client, a loopback
 * `http://127.0.0.1/…` URI on any port matching a registered loopback URI's path (RFC 8252 §7.3).
 */
export function redirectUriAllowed(meta: ClientMeta, uri: string): boolean {
  if (meta.redirectUris.includes(uri)) {
    return true;
  }
  if (meta.applicationType !== 'native') {
    return false;
  }
  const candidate = attempt(() => new URL(uri));
  if (candidate === undefined) {
    return false;
  }
  if (
    candidate.protocol !== HTTP_SCHEME ||
    candidate.hostname !== LOOPBACK_HOST
  ) {
    return false;
  }
  return meta.redirectUris.some(allowed => {
    const allowedUrl = attempt(() => new URL(allowed));
    if (allowedUrl === undefined) {
      return false;
    }
    return (
      allowedUrl.protocol === HTTP_SCHEME &&
      allowedUrl.hostname === LOOPBACK_HOST &&
      allowedUrl.pathname === candidate.pathname &&
      allowedUrl.search === candidate.search
    );
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
