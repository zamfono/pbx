import type { RequestEvent } from '@sveltejs/kit';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  HTTP_OK,
  HTTP_SERVICE_UNAVAILABLE,
  type HealthDocument,
  type HealthStatus
} from '@zamfono/shared';

import { currentHealth } from '#lib/server/health.js';
import { requestEvent } from '#testing/requestEvent.js';

import { GET } from './+server.js';

vi.mock('#lib/server/health.js', () => ({ currentHealth: vi.fn() }));

const TOKEN = 'metrics-token';

afterEach(() => {
  vi.unstubAllEnvs();
});

/** The stack's health document is `status`, its checks one `sipBan:helper` of that status. */
function healthIs(status: HealthStatus): HealthDocument {
  const document: HealthDocument = {
    status,
    checks: {
      'database:status': [{ status: 'pass' }],
      'sipBan:helper': [{ status }]
    }
  };
  vi.mocked(currentHealth).mockResolvedValue(document);
  return document;
}

function eventWithAuth(authorization?: string): RequestEvent {
  return requestEvent('http://api/healthz', {
    init: { headers: authorization === undefined ? {} : { authorization } }
  });
}

describe('GET /healthz views (§6.3 "Health")', () => {
  it.each([
    ['pass', HTTP_OK],
    ['warn', HTTP_OK],
    ['fail', HTTP_SERVICE_UNAVAILABLE]
  ] as const)(
    'answers %s without credentials with the overall status alone, HTTP %i',
    async (status, http) => {
      vi.stubEnv('METRICS_TOKEN', TOKEN);
      healthIs(status);
      const response = await GET(eventWithAuth());
      expect(response.status).toBe(http);
      expect(response.headers.get('content-type')).toBe(
        'application/health+json'
      );
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(await response.json()).toEqual({ status });
    }
  );

  it('answers the full document to the bearer of METRICS_TOKEN', async () => {
    vi.stubEnv('METRICS_TOKEN', TOKEN);
    const document = healthIs('fail');
    const response = await GET(eventWithAuth(`Bearer ${TOKEN}`));
    expect(response.status).toBe(HTTP_SERVICE_UNAVAILABLE);
    expect(await response.json()).toEqual(document);
  });

  it.each([
    `Bearer ${TOKEN}x`,
    `Bearer ${TOKEN.slice(1)}`,
    TOKEN,
    `Basic ${TOKEN}`
  ])(
    'answers the status alone, never 401, on a wrong token (%s)',
    async auth => {
      vi.stubEnv('METRICS_TOKEN', TOKEN);
      healthIs('warn');
      const response = await GET(eventWithAuth(auth));
      expect(response.status).toBe(HTTP_OK);
      expect(await response.json()).toEqual({ status: 'warn' });
    }
  );

  it.each(
    [undefined, ''].flatMap(token =>
      [undefined, 'Bearer ', 'Bearer undefined'].map(auth => [token, auth])
    )
  )(
    'answers the status alone while METRICS_TOKEN is %j (authorization %j)',
    async (token, auth) => {
      vi.stubEnv('METRICS_TOKEN', token);
      healthIs('pass');
      const response = await GET(eventWithAuth(auth));
      expect(await response.json()).toEqual({ status: 'pass' });
    }
  );
});
