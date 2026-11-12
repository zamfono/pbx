import { buildOpenApiDocument } from '#lib/server/openapi.js';

// The document depends on nothing but the code and HOST_CONTROL, so `vite build` writes it once
// for a stack without host control, and its variant with it (openapi-host-control.json), and
// adapter-node serves the file `server.ts` picks (`openApiUrl`).
export const prerender = true;

/** `GET /api/v1/openapi.json` (§10.3): the OpenAPI 3.1 document generated from the route table and each registered operation's zod schema. */
export function GET(): Response {
  return new Response(
    JSON.stringify(buildOpenApiDocument({ hostControl: false })),
    { headers: { 'content-type': 'application/json' } }
  );
}
