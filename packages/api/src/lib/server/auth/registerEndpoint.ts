import { z } from 'zod';

import { HTTP_BAD_REQUEST, HTTP_CREATED } from '@zamfono/shared';

import { tryReadJson } from '../json.js';
import type { Keyring } from '../secretbox.js';
import { encodeMetadataClientId } from './clients.js';
import { NO_AUTH_METHOD, oauthError, type BaseDeps } from './oauthHttp.js';
import { redirectUriAcceptable } from './redirectUris.js';

// RFC 7591 dynamic client registration limits (§5.2).
const MAX_CLIENT_NAME_LENGTH = 100;
const MAX_REDIRECT_URIS = 5;
const MAX_REDIRECT_URI_LENGTH = 512;

const RegisterRequestSchema = z
  .object({
    client_name: z.string().min(1).max(MAX_CLIENT_NAME_LENGTH),
    redirect_uris: z
      .array(z.string().max(MAX_REDIRECT_URI_LENGTH))
      .min(1)
      .max(MAX_REDIRECT_URIS),
    application_type: z.enum(['native', 'web'])
  })
  .refine(request =>
    request.redirect_uris.every(uri =>
      redirectUriAcceptable(uri, request.application_type)
    )
  );

export type RegisterDeps = BaseDeps & { keyring: Keyring };

/**
 * `POST /oauth/register` (RFC 7591): stateless — the returned `client_id` is the metadata
 * itself, encrypted (§5.2), so an invalid or abandoned registration writes nothing. The §5.5
 * per-address limit is the server hooks' (`hooks.server.ts`), which answer 429 before this runs.
 */
export async function registerEndpoint(
  deps: RegisterDeps,
  req: Request
): Promise<Response> {
  const body = await tryReadJson(req);
  if (body === undefined) {
    return oauthError(HTTP_BAD_REQUEST, 'invalid_client_metadata');
  }
  const parsed = RegisterRequestSchema.safeParse(body);
  if (!parsed.success) {
    return oauthError(HTTP_BAD_REQUEST, 'invalid_client_metadata');
  }
  const clientId = encodeMetadataClientId(deps.keyring, {
    name: parsed.data.client_name,
    redirectUris: parsed.data.redirect_uris,
    applicationType: parsed.data.application_type
  });
  return new Response(
    JSON.stringify({
      client_id: clientId,
      client_name: parsed.data.client_name,
      redirect_uris: parsed.data.redirect_uris,
      application_type: parsed.data.application_type,
      token_endpoint_auth_method: NO_AUTH_METHOD
    }),
    {
      status: HTTP_CREATED,
      headers: { 'content-type': 'application/json' }
    }
  );
}
