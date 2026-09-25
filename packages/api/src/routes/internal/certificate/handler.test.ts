import type { RequestEvent } from '@sveltejs/kit';
import { describe, expect, it, vi } from 'vitest';

const STATUS_NOT_FOUND = 404;
const STATUS_ACCEPTED = 202;

const notify = vi.fn();
vi.mock('../../../lib/jobs/certSync.js', () => ({
  getCertSyncScheduler: () => ({
    status: () => 'ok',
    notify,
    stop: () => undefined
  })
}));

const { POST } = await import('./+server.js');

/** A minimal `RequestEvent`-shaped value: the handler reads only `event.request`. */
function eventFor(request: Request): RequestEvent {
  return { request } as RequestEvent;
}

describe('POST /internal/certificate', () => {
  it('returns 404 when the request carries X-Forwarded-For, without triggering a sync', () => {
    notify.mockClear();
    const request = new Request('http://internal/internal/certificate', {
      method: 'POST',
      headers: { 'x-forwarded-for': '203.0.113.9' }
    });
    // eslint-disable-next-line new-cap -- POST is the fixed SvelteKit route-handler export name
    const response = POST(eventFor(request));
    expect(response.status).toBe(STATUS_NOT_FOUND);
    expect(notify).not.toHaveBeenCalled();
  });

  it('returns 202 and triggers a sync pass for a request with no X-Forwarded-For', () => {
    notify.mockClear();
    const request = new Request('http://internal/internal/certificate', {
      method: 'POST'
    });
    // eslint-disable-next-line new-cap -- POST is the fixed SvelteKit route-handler export name
    const response = POST(eventFor(request));
    expect(response.status).toBe(STATUS_ACCEPTED);
    expect(notify).toHaveBeenCalledOnce();
  });
});
