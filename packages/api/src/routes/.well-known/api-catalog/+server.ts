import { HEALTH_CONTENT_TYPE } from '@zamfono/shared';

import { API_PREFIX } from '#lib/server/restRoutes.js';
import { originFromEnv } from '#lib/server/stackAddress.js';

const API_CATALOG_CONTENT_TYPE =
  'application/linkset+json; profile="https://www.rfc-editor.org/info/rfc9727"';

/**
 * `GET /.well-known/api-catalog` (§10.3 "API catalog", RFC 9727): a linkset (RFC 9264) with one
 * link context, the REST API, linking its OpenAPI document and `/healthz` as absolute URLs.
 */
export function GET(): Response {
  const origin = originFromEnv();
  const linkset = {
    linkset: [
      {
        anchor: `${origin}${API_PREFIX}`,
        'service-desc': [
          {
            href: `${origin}${API_PREFIX}/openapi.json`,
            type: 'application/vnd.oai.openapi+json'
          }
        ],
        status: [{ href: `${origin}/healthz`, type: HEALTH_CONTENT_TYPE }]
      }
    ]
  };
  return new Response(JSON.stringify(linkset), {
    headers: { 'content-type': API_CATALOG_CONTENT_TYPE }
  });
}
