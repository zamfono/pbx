/**
 * The OAuth 2.1 authorization server's JSON endpoints (§5.2): revocation and the RFC 8414
 * metadata document here, the token grants (`tokenEndpoint.ts`) and dynamic client registration
 * (`registerEndpoint.ts`) re-exported, so each route imports from one place.
 */
import { HTTP_OK } from '@zamfono/shared';

import {
  GRANT_AUTHORIZATION_CODE,
  GRANT_REFRESH_TOKEN,
  NO_AUTH_METHOD,
  readForm,
  type BaseDeps
} from './oauthHttp.js';
import { hashToken } from './tokens.js';

export { registerEndpoint, type RegisterDeps } from './registerEndpoint.js';
export { tokenEndpoint, type TokenDeps } from './tokenEndpoint.js';

export type RevokeDeps = BaseDeps;

/** `POST /oauth/revoke` (RFC 7009): always 200, so a caller learns nothing about the token. */
export async function revokeEndpoint(
  deps: RevokeDeps,
  req: Request
): Promise<Response> {
  const params = await readForm(req);
  const token = params.get('token');
  if (token !== null) {
    await deps.db
      .updateTable('tokens')
      .set({ revokedAt: deps.now() })
      .where('tokenHash', '=', hashToken(token))
      .where('revokedAt', 'is', null)
      .execute();
  }
  return new Response(null, { status: HTTP_OK });
}

/** RFC 8414 authorization server metadata, also served as the OpenID discovery document. */
export function metadataDocument(origin: string): object {
  /* eslint-disable camelcase -- RFC 8414 mandates these snake_case wire fields */
  return {
    issuer: origin,
    authorization_endpoint: `${origin}/oauth/authorize`,
    token_endpoint: `${origin}/oauth/token`,
    revocation_endpoint: `${origin}/oauth/revoke`,
    registration_endpoint: `${origin}/oauth/register`,
    response_types_supported: ['code'],
    grant_types_supported: [GRANT_AUTHORIZATION_CODE, GRANT_REFRESH_TOKEN],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: [NO_AUTH_METHOD],
    client_id_metadata_document_supported: true,
    // RFC 9207: the authorization response carries `iss`, so a client with several
    // authorization servers configured can tell which one a redirect came from.
    authorization_response_iss_parameter_supported: true
  };
  /* eslint-enable camelcase -- RFC 8414 mandates these snake_case wire fields */
}
