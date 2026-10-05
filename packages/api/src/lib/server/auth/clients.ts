import type { IncomingMessage } from 'node:http';
import { request } from 'node:https';
import { z } from 'zod';

import {
  HTTP_OK,
  isRecord,
  MS_PER_DAY,
  MS_PER_SECOND,
  type Db,
  type OAuthClientKind
} from '@zamfono/shared';

import { attempt } from '../errors.js';
import { tryParseJson } from '../json.js';
import { isNonPublicLiteral, publicLookup } from '../publicHost.js';
import { decrypt, encrypt, type Keyring } from '../secretbox.js';
import { TtlMap } from '../ttlMap.js';
import { redirectUriAcceptable } from './redirectUris.js';

// §5.2 "Client registration": the client-id-metadata-document fetch is cached in memory per the
// document's own Cache-Control max-age; a document without one, or marked no-store or no-cache,
// is fetched every time.
const CACHE_CONTROL_MAX_AGE = /max-age=(?<seconds>\d+)/u;
const CACHE_CONTROL_NO_CACHE = /\bno-(?:store|cache)\b/u;
// Anyone can name any URL at `/oauth/authorize`, and a document picks its own max-age: the cache
// holds this many documents, for at most a day each.
const CIMD_CACHE_MAX_ENTRIES = 1000;
const CIMD_CACHE_MAX_TTL_MS = MS_PER_DAY;
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
// RFC 7591 dynamic client registration limits (§5.2), which a metadata document meets too.
const MAX_CLIENT_NAME_LENGTH = 100;
const MAX_REDIRECT_URIS = 5;
const MAX_REDIRECT_URI_LENGTH = 512;

/** The client metadata both registration mechanisms carry (§5.2), in its wire spelling. */
export const ClientMetadataSchema = z.object({
  client_name: z.string().min(1).max(MAX_CLIENT_NAME_LENGTH),
  redirect_uris: z
    .array(z.string().max(MAX_REDIRECT_URI_LENGTH))
    .min(1)
    .max(MAX_REDIRECT_URIS),
  application_type: z.enum(['native', 'web'])
});

/** Every redirect URI of `metadata` may be registered for its `application_type` (§5.2). */
export function redirectUrisAcceptable(
  metadata: z.infer<typeof ClientMetadataSchema>
): boolean {
  return metadata.redirect_uris.every(uri =>
    redirectUriAcceptable(uri, metadata.application_type)
  );
}

const CimdDocumentSchema = ClientMetadataSchema.extend({
  client_id: z.string(),
  application_type: ClientMetadataSchema.shape.application_type.default(
    DEFAULT_APPLICATION_TYPE
  )
}).refine(redirectUrisAcceptable);

/** An OAuth client, however it registered (§5.2). */
export type ClientMeta = {
  clientId: string;
  kind: OAuthClientKind;
  name: string;
  redirectUris: string[];
  applicationType: 'native' | 'web';
};

const cimdCache = new TtlMap<string, ClientMeta>(
  () => Date.now(),
  CIMD_CACHE_MAX_ENTRIES
);

/** Encodes `meta` as a `client_id`: the JSON metadata, secretbox-encrypted and base64url'd. */
export function encodeMetadataClientId(
  kr: Keyring,
  meta: Omit<ClientMeta, 'clientId' | 'kind'>
): string {
  return encrypt(kr, 'oauth.clientId', JSON.stringify(meta)).toString(
    'base64url'
  );
}

/** Decodes a metadata `client_id`; `null` on a malformed blob or an unreadable key generation. */
export function decodeMetadataClientId(
  kr: Keyring,
  id: string
): ClientMeta | null {
  const plain = attempt(() =>
    decrypt(kr, 'oauth.clientId', Buffer.from(id, 'base64url'))
  );
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

function cacheTtlMs(cacheControl: string): number | null {
  if (CACHE_CONTROL_NO_CACHE.test(cacheControl)) {
    return null;
  }
  const match = CACHE_CONTROL_MAX_AGE.exec(cacheControl);
  const seconds = match?.groups?.seconds;
  return seconds === undefined
    ? null
    : Math.min(Number(seconds) * MS_PER_SECOND, CIMD_CACHE_MAX_TTL_MS);
}

function parseCimdDocument(
  clientIdUrl: string,
  body: unknown
): ClientMeta | null {
  const parsed = CimdDocumentSchema.safeParse(body);
  if (!parsed.success || parsed.data.client_id !== clientIdUrl) {
    return null;
  }
  return {
    clientId: clientIdUrl,
    kind: 'cimd',
    name: parsed.data.client_name,
    redirectUris: parsed.data.redirect_uris,
    applicationType: parsed.data.application_type
  };
}

/** `response`'s body parsed as JSON, or `undefined` when it is not JSON or exceeds
 *  `CIMD_MAX_BYTES`, which is checked while it streams in rather than once it is all held. */
async function cappedJson(response: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of response as AsyncIterable<Buffer>) {
    size += chunk.byteLength;
    if (size > CIMD_MAX_BYTES) {
      response.destroy();
      return undefined;
    }
    chunks.push(chunk);
  }
  return tryParseJson(Buffer.concat(chunks).toString('utf8'));
}

/** The response to a GET of `url`, its host resolved only as the socket connects, through
 *  `publicLookup`; rejects on a refused address, a failed connection or the deadline. */
function getDocument(url: URL): Promise<IncomingMessage> {
  return new Promise((resolve, reject) => {
    request(
      url,
      {
        lookup: publicLookup,
        signal: AbortSignal.timeout(CIMD_FETCH_TIMEOUT_MS)
      },
      resolve
    )
      .on('error', reject)
      .end();
  });
}

/**
 * Fetches a Client ID Metadata Document (§5.2), refusing it unless its own `client_id` equals the
 * URL it was fetched from; caches the result per `Cache-Control`. `null` for a document that
 * cannot be fetched in time, redirects, is not JSON, is too large or does not describe a client,
 * and for a host on a loopback, private or link-local address, which is never connected to.
 */
export async function fetchCimd(
  clientIdUrl: string
): Promise<ClientMeta | null> {
  const cached = cimdCache.get(clientIdUrl);
  if (cached) {
    return cached;
  }
  const url = URL.parse(clientIdUrl);
  if (url === null || isNonPublicLiteral(url)) {
    return null;
  }
  try {
    const response = await getDocument(url);
    // A redirect is not followed: it could lead where the address check did not look.
    if (response.statusCode !== HTTP_OK) {
      response.destroy();
      return null;
    }
    const meta = parseCimdDocument(clientIdUrl, await cappedJson(response));
    const ttlMs = cacheTtlMs(response.headers['cache-control'] ?? '');
    if (meta && ttlMs !== null) {
      cimdCache.set(clientIdUrl, meta, Date.now() + ttlMs);
    }
    return meta;
  } catch {
    // A non-public address, a refused connection, a failed TLS handshake or the deadline: an
    // unreachable client.
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
      createdAt: now,
      lastLoginAt: now
    })
    .onConflict(oc =>
      oc.column('clientId').doUpdateSet({
        name: meta.name,
        lastLoginAt: now
      })
    )
    .execute();
}
