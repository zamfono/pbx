import { buildOpenApiDocument } from '$lib/server/openapi.js';

// Side-effect import: fills the registry (§10.3) so the document below carries every area's
// zod-derived schema instead of listing paths with no operation registered.
import '$lib/server/ops/index.js';

/** `GET /api/v1/openapi.json` (§10.3): the OpenAPI 3.1 document generated from the route table and each registered operation's zod schema. */
export function GET(): Response {
  return new Response(JSON.stringify(buildOpenApiDocument()), {
    headers: { 'content-type': 'application/json' }
  });
}
