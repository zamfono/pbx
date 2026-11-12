import { buildOpenApiDocument } from '#lib/server/openapi.js';

// The variant of `/api/v1/openapi.json` for a stack with `HOST_CONTROL=true` (§6.3 "Host
// control"), written once by `vite build`; `server.ts` serves it at that path (`openApiUrl`) and
// answers its own path 404.
export const prerender = true;

export function GET(): Response {
  return new Response(
    JSON.stringify(buildOpenApiDocument({ hostControl: true })),
    { headers: { 'content-type': 'application/json' } }
  );
}
