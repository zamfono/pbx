import { z } from 'zod';

import type { Keyring } from '../secretbox.js';
import { encodeMetadataClientId } from './clients.js';
import {
  NO_AUTH_METHOD,
  oauthError,
  STATUS_BAD_REQUEST,
  STATUS_CREATED,
  type BaseDeps
} from './oauthHttp.js';

// RFC 7591 dynamic client registration limits (§5.2).
const MAX_CLIENT_NAME_LENGTH = 100;
const MAX_REDIRECT_URIS = 5;
const MAX_REDIRECT_URI_LENGTH = 512;

/* eslint-disable camelcase -- RFC 7591 mandates these snake_case wire fields */
const RegisterRequestSchema = z.object({
  client_name: z.string().min(1).max(MAX_CLIENT_NAME_LENGTH),
  redirect_uris: z
    .array(z.string().max(MAX_REDIRECT_URI_LENGTH))
    .min(1)
    .max(MAX_REDIRECT_URIS),
  application_type: z.enum(['native', 'web'])
});
/* eslint-enable camelcase -- RFC 7591 mandates these snake_case wire fields */

export type RegisterDeps = BaseDeps & { keyring: Keyring };

/** `req.json()`, or `undefined` when the body is not valid JSON. */
async function attemptJson(req: Request): Promise<unknown> {
  try {
    return await req.json();
  } catch {
    return undefined;
  }
}

/**
 * `POST /oauth/register` (RFC 7591): stateless — the returned `client_id` is the metadata
 * itself, encrypted (§5.2), so an invalid or abandoned registration writes nothing. The §5.5
 * per-address limit is the server hooks' (`hooks.server.ts`), which answer 429 before this runs.
 */
export async function registerEndpoint(
  deps: RegisterDeps,
  req: Request
): Promise<Response> {
  const body = await attemptJson(req);
  if (body === undefined) {
    return oauthError(STATUS_BAD_REQUEST, 'invalid_client_metadata');
  }
  const parsed = RegisterRequestSchema.safeParse(body);
  if (!parsed.success) {
    return oauthError(STATUS_BAD_REQUEST, 'invalid_client_metadata');
  }
  const clientId = encodeMetadataClientId(deps.keyring, {
    name: parsed.data.client_name,
    redirectUris: parsed.data.redirect_uris,
    applicationType: parsed.data.application_type
  });
  return new Response(
    /* eslint-disable camelcase -- RFC 7591 mandates these snake_case wire fields */
    JSON.stringify({
      client_id: clientId,
      client_name: parsed.data.client_name,
      redirect_uris: parsed.data.redirect_uris,
      application_type: parsed.data.application_type,
      token_endpoint_auth_method: NO_AUTH_METHOD
    }),
    /* eslint-enable camelcase -- RFC 7591 mandates these snake_case wire fields */
    {
      status: STATUS_CREATED,
      headers: { 'content-type': 'application/json' }
    }
  );
}
