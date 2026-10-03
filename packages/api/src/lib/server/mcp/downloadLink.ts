import { epochSeconds, MS_PER_SECOND } from '@zamfono/shared';

import { ACCESS_TOKEN_PARAM, type Authenticated } from '../auth/bearer.js';
import { encodeDownloadToken } from '../auth/jwt.js';
import { API_PREFIX, captureField, routes } from '../restRoutes.js';
import type { McpDeps } from './auth.js';

// §10.5 "Audio": a file a tool returns is answered as a link to the operation's own REST
// endpoint, signed for that one path and opening without the MCP session's bearer token.
const DOWNLOAD_LINK_TTL_S = 300;
const CAPTURE = /\{(?<name>[^}]+)\}/gu;

/** The download link a file-returning tool call answers with: the URL and when it stops opening. */
export type DownloadLink = { url: string; expiresAt: string };

/**
 * The link to operation `op`'s `GET` route for `args`, the input the tool call ran with: the
 * path's captures from their input fields, every other field as the query, and the token of
 * `auth`'s user and client for that path, valid for five minutes.
 */
export async function downloadLink(
  deps: McpDeps,
  auth: Authenticated,
  op: string,
  args: Record<string, unknown>
): Promise<DownloadLink> {
  const route = routes.find(row => row.method === 'GET' && row.op === op);
  if (!route) {
    throw new Error(`${op} has no GET route to link to`);
  }
  const query = new URLSearchParams();
  const pathFields = new Set<string>();
  const path = `${API_PREFIX}${route.pattern.replace(
    CAPTURE,
    (_match, name: string) => {
      const field = captureField(route, name);
      pathFields.add(field);
      return encodeURIComponent(String(args[field]));
    }
  )}`;
  for (const [field, value] of Object.entries(args)) {
    if (!pathFields.has(field)) {
      query.set(field, String(value));
    }
  }
  const nowS = epochSeconds(Date.now());
  const exp = nowS + DOWNLOAD_LINK_TTL_S;
  const token = await encodeDownloadToken(deps.jwtSecret, {
    sub: auth.actor.id,
    cid: auth.clientId ?? null,
    aud: path,
    iat: nowS,
    exp
  });
  query.set(ACCESS_TOKEN_PARAM, token);
  return {
    url: `${deps.origin}${path}?${query.toString()}`,
    expiresAt: new Date(exp * MS_PER_SECOND).toISOString()
  };
}
