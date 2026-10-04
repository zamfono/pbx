import { HTTP_BAD_REQUEST, HTTP_CREATED } from '@zamfono/shared';

import { readJsonBody } from '../requestBody.js';
import type { Keyring } from '../secretbox.js';
import {
  ClientMetadataSchema,
  encodeMetadataClientId,
  redirectUrisAcceptable
} from './clients.js';
import { NO_AUTH_METHOD, oauthError, type BaseDeps } from './oauthHttp.js';

const RegisterRequestSchema = ClientMetadataSchema.refine(
  redirectUrisAcceptable
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
  const body = await readJsonBody(req);
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
