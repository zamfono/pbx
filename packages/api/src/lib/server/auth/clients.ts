import {
  isRecord,
  MS_PER_SECOND,
  type Db,
  type OAuthClientKind
} from '@zamfono/shared';

import { attempt } from '../errors.js';
import { tryParseJson } from '../json.js';
import { decrypt, encrypt, type Keyring } from '../secretbox.js';
import { TtlMap } from '../ttlMap.js';
import { redirectUriAcceptable } from './redirectUris.js';

// §5.2 "Client registration": the client-id-metadata-document fetch is cached in memory per the
// document's own Cache-Control max-age; a document without one, or marked no-store or no-cache,
// is fetched every time.
const CACHE_CONTROL_MAX_AGE = /max-age=(?<seconds>\d+)/u;
const CACHE_CONTROL_NO_CACHE = /\bno-(?:store|cache)\b/u;
// Anyone can make the server fetch a metadata document, unauthenticated: the fetch is bounded.
const CIMD_FETCH_TIMEOUT_MS = 5000;
const CIMD_MAX_BYTES = 65_536;
/** A Client ID Metadata Document `client_id` (mechanism 1) is an https URL; any other
 *  `client_id` is an encrypted registration (mechanism 2). */
const HTTPS_SCHEME = 'https://';
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
  const cacheControl = headers.get('cache-control') ?? '';
  if (CACHE_CONTROL_NO_CACHE.test(cacheControl)) {
    return null;
  }
  const match = CACHE_CONTROL_MAX_AGE.exec(cacheControl);
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
    (applicationType !== 'native' && applicationType !== 'web') ||
    !Array.isArray(redirectUris) ||
    !redirectUris.every(uri => typeof uri === 'string') ||
    !redirectUris.every(uri => redirectUriAcceptable(uri, applicationType))
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

/** `response`'s body parsed as JSON, or `undefined` when it is not JSON or exceeds
 *  `CIMD_MAX_BYTES`, which is checked while it streams in rather than once it is all held. */
async function cappedJson(response: Response): Promise<unknown> {
  if (response.body === null) {
    return undefined;
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.byteLength;
    if (size > CIMD_MAX_BYTES) {
      return undefined;
    }
    chunks.push(chunk);
  }
  return tryParseJson(Buffer.concat(chunks).toString('utf8'));
}

/**
 * Fetches a Client ID Metadata Document (§5.2), refusing it unless its own `client_id` equals the
 * URL it was fetched from; caches the result per `Cache-Control`. `null` for a document that
 * cannot be fetched in time, is not JSON, is too large or does not describe a client.
 */
export async function fetchCimd(
  clientIdUrl: string,
  fetchImpl: typeof fetch = fetch
): Promise<ClientMeta | null> {
  const cached = cimdCache.get(clientIdUrl);
  if (cached) {
    return cached;
  }
  try {
    const response = await fetchImpl(clientIdUrl, {
      signal: AbortSignal.timeout(CIMD_FETCH_TIMEOUT_MS)
    });
    if (!response.ok) {
      return null;
    }
    const meta = parseCimdDocument(clientIdUrl, await cappedJson(response));
    const ttlMs = cacheTtlMs(response.headers);
    if (meta && ttlMs !== null) {
      cimdCache.set(clientIdUrl, meta, Date.now() + ttlMs);
    }
    return meta;
  } catch {
    // A refused connection, a failed TLS handshake or the deadline: an unreachable client.
    return null;
  }
}

/** `clientId`'s metadata, fetched (mechanism 1) or decoded (mechanism 2); `null` for an unknown
 *  or unreachable client (§5.2 "Client registration"). */
export async function clientMetaFor(
  kr: Keyring,
  clientId: string
): Promise<ClientMeta | null> {
  return clientId.startsWith(HTTPS_SCHEME)
    ? fetchCimd(clientId)
    : decodeMetadataClientId(kr, clientId);
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
