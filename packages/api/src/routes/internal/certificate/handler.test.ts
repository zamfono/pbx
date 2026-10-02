import { describe, expect, it, vi } from 'vitest';

const STATUS_ACCEPTED = 202;

const notify = vi.fn();
vi.mock('#lib/server/jobs/certSync.js', () => ({
  notifyCertSync: notify
}));

const { POST } = await import('./+server.js');

describe('POST /internal/certificate', () => {
  it('returns 202 and triggers a sync pass', () => {
    // eslint-disable-next-line new-cap -- POST is the fixed SvelteKit route-handler export name
    const response = POST();
    expect(response.status).toBe(STATUS_ACCEPTED);
    expect(notify).toHaveBeenCalledOnce();
  });
});
