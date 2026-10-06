import type { IncomingMessage, ServerResponse } from 'node:http';

import { HTTP_NO_CONTENT, MS_PER_DAY, MS_PER_SECOND } from '@zamfono/shared';

/**
 * The endpoints that need no authentication and serve clients on other origins (§10.3 "CORS"), by
 * exact path, with the methods each serves: the static icons and the prerendered OpenAPI document
 * among them, which adapter-node serves before any hook runs. The password-reset endpoints, which
 * only the stack's own pages call, are not among them.
 */
const PUBLIC_ENDPOINTS: ReadonlyMap<string, string> = new Map([
  ['/healthz', 'GET, HEAD'],
  ['/api/v1/openapi.json', 'GET, HEAD'],
  ['/.well-known/api-catalog', 'GET, HEAD'],
  ['/.well-known/oauth-authorization-server', 'GET, HEAD'],
  ['/.well-known/oauth-protected-resource', 'GET, HEAD'],
  ['/.well-known/openid-configuration', 'GET, HEAD'],
  ['/favicon.ico', 'GET, HEAD'],
  ['/favicon.svg', 'GET, HEAD'],
  ['/logo.svg', 'GET, HEAD'],
  ['/logo.png', 'GET, HEAD'],
  ['/logoDark.svg', 'GET, HEAD'],
  ['/logoDark.png', 'GET, HEAD'],
  ['/oauth/register', 'POST'],
  ['/oauth/token', 'POST'],
  ['/oauth/revoke', 'POST']
]);

// The request headers those endpoints read: a JSON or form body, and a client's HTTP Basic
// authentication at the token and revocation endpoints.
const ALLOWED_HEADERS = 'Authorization, Content-Type';
// How long a browser may keep a preflight's answer: a day.
const MAX_AGE_S = MS_PER_DAY / MS_PER_SECOND;

/**
 * Opens a public endpoint to every origin (§10.3 "CORS"), never with credentials: sets
 * `Access-Control-Allow-Origin: *` on its response, and answers its `OPTIONS` preflight with 204
 * itself. Returns whether it answered; any other request goes on to the handler. It runs in
 * front of adapter-node's handler (`server.ts`), so the static files carry the header too.
 */
export function answerCors(req: IncomingMessage, res: ServerResponse): boolean {
  const [pathname = ''] = (req.url ?? '').split('?');
  const methods = PUBLIC_ENDPOINTS.get(pathname);
  if (methods === undefined) {
    return false;
  }
  res.setHeader('access-control-allow-origin', '*');
  if (req.method !== 'OPTIONS') {
    return false;
  }
  res
    .writeHead(HTTP_NO_CONTENT, {
      'access-control-allow-methods': methods,
      'access-control-allow-headers': ALLOWED_HEADERS,
      'access-control-max-age': String(MAX_AGE_S)
    })
    .end();
  return true;
}
