import { z } from 'zod';

import {
  epochSeconds,
  HTTP_UNPROCESSABLE_CONTENT,
  MS_PER_SECOND
} from '@zamfono/shared';

import { ACCESS_TOKEN_PARAM, type Authenticated } from '../auth/bearer.js';
import { encodeLinkToken, type LinkKind } from '../auth/jwt.js';
import { findOperation } from '../ops/gates.js';
import { checkAccess, type RunInput } from '../ops/runner.js';
import { OpError } from '../ops/types.js';
import {
  API_PREFIX,
  captureField,
  routes,
  UPLOAD_FIELD,
  uploadRoute,
  type RouteEntry
} from '../restRoutes.js';
import { UPLOAD_PREFIX } from '../uploadLink.js';
import type { McpDeps } from './auth.js';

// §10.5 "Audio", "Uploads": a file a tool returns or takes travels through a link to the
// operation's own REST path, signed for that one path and opening without the MCP session's
// bearer token.
const LINK_TTL_S = 300;
const CAPTURE = /\{(?<name>[^}]+)\}/gu;

/** The link a file tool call answers with: the URL and when it stops opening. */
export const operationLink = z.object({
  url: z.string(),
  expiresAt: z.string()
});
export type OperationLink = z.infer<typeof operationLink>;

/**
 * The link of `kind` to `route` for `args`, the tool call's input: the path's captures from their
 * input fields, every other field as the query, and the token of `auth`'s user and client for
 * the REST path, valid for five minutes. A download link is that REST path itself; an upload
 * link is it below `UPLOAD_PREFIX`, the page and endpoint that take the file.
 */
async function signedLink(
  deps: McpDeps,
  auth: Authenticated,
  kind: LinkKind,
  route: RouteEntry,
  args: Record<string, unknown>
): Promise<OperationLink> {
  const query = new URLSearchParams();
  const pathFields = new Set<string>();
  const path = route.pattern.replace(CAPTURE, (_match, name: string) => {
    const field = captureField(route, name);
    pathFields.add(field);
    return encodeURIComponent(String(args[field]));
  });
  for (const [field, value] of Object.entries(args)) {
    if (!pathFields.has(field)) {
      query.set(field, String(value));
    }
  }
  const nowS = epochSeconds(Date.now());
  const exp = nowS + LINK_TTL_S;
  const token = await encodeLinkToken(deps.jwtSecret, kind, {
    sub: auth.actor.id,
    cid: auth.clientId ?? null,
    aud: `${API_PREFIX}${path}`,
    iat: nowS,
    exp
  });
  query.set(ACCESS_TOKEN_PARAM, token);
  const prefix = kind === 'download' ? API_PREFIX : UPLOAD_PREFIX;
  return {
    url: `${deps.origin}${prefix}${path}?${query.toString()}`,
    expiresAt: new Date(exp * MS_PER_SECOND).toISOString()
  };
}

/** The download link to operation `op`'s `GET` route for `args` (§10.5 "Audio"). */
export async function downloadLink(
  deps: McpDeps,
  auth: Authenticated,
  op: string,
  args: Record<string, unknown>
): Promise<OperationLink> {
  const route = routes.find(row => row.method === 'GET' && row.op === op);
  if (!route) {
    throw new Error(`${op} has no GET route to link to`);
  }
  return signedLink(deps, auth, 'download', route, args);
}

/**
 * The upload link for upload operation `op` with `args`, its input without the file (§10.5
 * "Uploads"): refused as `run` would be for input that is invalid even before the file (422), a
 * role below the operation's or a target outside the caller's own scope (403), so a link that
 * cannot succeed is never handed out.
 */
export async function uploadLink(
  deps: McpDeps,
  auth: Authenticated,
  run: RunInput,
  op: string,
  args: Record<string, unknown>
): Promise<OperationLink> {
  const route = uploadRoute(op);
  const operation = findOperation(op);
  if (!route || !(operation.input instanceof z.ZodObject)) {
    throw new Error(`${op} takes no upload to link to`);
  }
  const parsed = operation.input.omit({ [UPLOAD_FIELD]: true }).safeParse(args);
  if (!parsed.success) {
    throw new OpError(
      HTTP_UNPROCESSABLE_CONTENT,
      'validation failed',
      parsed.error.issues
    );
  }
  await checkAccess(deps.db, op, parsed.data, run);
  return signedLink(deps, auth, 'upload', route, args);
}
