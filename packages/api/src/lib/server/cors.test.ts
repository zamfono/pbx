import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { answerCors } from './cors.js';

// `server.ts`'s wiring in front of a handler that answers as adapter-node's do, with `writeHead`.
const server = http.createServer((req, res) => {
  if (!answerCors(req, res)) {
    res.writeHead(200, { 'content-type': 'text/plain' }).end('handler');
  }
});
let base = '';

beforeAll(async () => {
  await new Promise<void>(resolve => {
    server.listen(0, '127.0.0.1', resolve);
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise(resolve => {
    server.close(resolve);
  });
});

const PUBLIC_PATHS = [
  '/healthz',
  '/api/v1/openapi.json',
  '/.well-known/api-catalog',
  '/.well-known/oauth-authorization-server',
  '/.well-known/oauth-protected-resource',
  '/.well-known/openid-configuration',
  '/favicon.ico',
  '/favicon.svg',
  '/logo.svg',
  '/logo.png',
  '/logoDark.svg',
  '/logoDark.png',
  '/oauth/register',
  '/oauth/token',
  '/oauth/revoke'
];

const CLOSED_PATHS = [
  '/api/v1/users',
  '/mcp',
  '/oauth/authorize',
  '/oauth/callback',
  '/auth/forgot',
  '/auth/resetRequest',
  '/auth/reset',
  '/upload/x',
  '/internal/certificate',
  '/readyz',
  '/metrics'
];

describe('answerCors', () => {
  it.each(PUBLIC_PATHS)(
    'opens %s to every origin, without credentials',
    async path => {
      const response = await fetch(`${base}${path}?q=1`, {
        headers: { origin: 'https://elsewhere.example' }
      });

      expect(await response.text()).toBe('handler');
      expect(response.headers.get('access-control-allow-origin')).toBe('*');
      expect(response.headers.has('access-control-allow-credentials')).toBe(
        false
      );
    }
  );

  it.each(CLOSED_PATHS)('leaves %s closed', async path => {
    const response = await fetch(`${base}${path}`, {
      headers: { origin: 'https://elsewhere.example' }
    });

    expect(await response.text()).toBe('handler');
    expect(response.headers.has('access-control-allow-origin')).toBe(false);
  });

  it('answers the preflight of a public endpoint itself', async () => {
    const response = await fetch(`${base}/oauth/token`, {
      method: 'OPTIONS',
      headers: {
        origin: 'https://elsewhere.example',
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'authorization, content-type'
      }
    });

    expect(response.status).toBe(204);
    expect(Object.fromEntries(response.headers)).toMatchObject({
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'POST',
      'access-control-allow-headers': 'Authorization, Content-Type',
      'access-control-max-age': '86400'
    });
  });

  it('passes the OPTIONS request of a closed path on to the handler', async () => {
    const response = await fetch(`${base}/api/v1/users`, {
      method: 'OPTIONS'
    });

    expect(await response.text()).toBe('handler');
    expect(response.headers.has('access-control-allow-origin')).toBe(false);
  });
});
