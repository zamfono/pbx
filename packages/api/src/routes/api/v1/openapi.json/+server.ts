import { buildOpenApiDocument } from '#lib/server/openapi.js';

// The document depends on nothing but the code, so `vite build` writes it once and adapter-node
// serves that file.
export const prerender = true;

/** `GET /api/v1/openapi.json` (§10.3): the OpenAPI 3.1 document generated from the route table and each registered operation's zod schema. */
export function GET(): Response {
  return new Response(JSON.stringify(buildOpenApiDocument()), {
    headers: { 'content-type': 'application/json' }
  });
}
