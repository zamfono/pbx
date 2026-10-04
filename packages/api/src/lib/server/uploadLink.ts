/**
 * The receiving end of an upload link (§10.5 "Uploads"): `/upload/<path>` stands for the upload
 * operation at REST path `/api/v1/<path>`, and the link's token, of kind `upload`, is signed for
 * that REST path. A `POST` of the file to the link and the file-picker page's form both run the
 * operation here.
 */
import {
  HTTP_NOT_FOUND,
  HTTP_UNAUTHORIZED,
  newId,
  type Db
} from '@zamfono/shared';

import { authenticateLink, type Authenticated } from './auth/bearer.js';
import { runOperation } from './ops/runner.js';
import { OpError } from './ops/types.js';
import { matchUploadRoute, type Matched } from './rest.js';
import { API_PREFIX, pathInput } from './restRoutes.js';
import { parseQuery } from './restTransport.js';

/** The path prefix of every upload link. */
export const UPLOAD_PREFIX = '/upload';

export type UploadLinkDeps = { db: Db; jwtSecret: string };

/** The upload route link `url` addresses, and the REST path it stands for; `null` for none. */
function linkRoute(url: URL): { matched: Matched; apiPath: string } | null {
  if (!url.pathname.startsWith(`${UPLOAD_PREFIX}/`)) {
    return null;
  }
  const path = url.pathname.slice(UPLOAD_PREFIX.length);
  const matched = matchUploadRoute(path);
  return matched && { matched, apiPath: `${API_PREFIX}${path}` };
}

/** The live user link `url`'s token acts as; `null` for a token that fails (expired, another
 *  path, another kind) or a link that names no upload route. */
export async function uploadLinkAuth(
  deps: UploadLinkDeps,
  url: URL
): Promise<Authenticated | null> {
  const target = linkRoute(url);
  return target && authenticateLink(deps, 'upload', url, target.apiPath);
}

/**
 * Runs the upload operation link `url` stands for with `fields`, the posted form: the input is
 * the link's query, the form and the path's captures. It runs as the token's user and OAuth
 * client with channel `mcp`, since the link completes that client's tool call, and is audited
 * like any run (§5.7). A link that names no upload route is a 404, a failing token a 401.
 */
export async function runUploadLink(
  deps: UploadLinkDeps,
  url: URL,
  fields: Record<string, unknown>
): Promise<unknown> {
  const target = linkRoute(url);
  if (!target) {
    throw new OpError(HTTP_NOT_FOUND, 'no such upload');
  }
  const auth = await authenticateLink(deps, 'upload', url, target.apiPath);
  if (!auth) {
    throw new OpError(HTTP_UNAUTHORIZED, 'unauthorized');
  }
  const { route, queryKinds, match } = target.matched;
  const input = {
    ...parseQuery(url, queryKinds),
    ...fields,
    ...pathInput(route, match.groups ?? {})
  };
  return runOperation(deps.db, route.op, input, {
    actor: auth.actor,
    channel: 'mcp',
    clientId: auth.clientId,
    clientName: auth.clientName,
    requestId: newId()
  });
}
