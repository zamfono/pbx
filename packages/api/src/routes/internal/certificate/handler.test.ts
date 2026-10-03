import { describe, expect, it, vi } from 'vitest';

import { HTTP_ACCEPTED } from '@zamfono/shared';

const notify = vi.fn();
vi.mock('#lib/server/jobs/certSync.js', () => ({
  notifyCertSync: notify
}));

const { POST } = await import('./+server.js');

describe('POST /internal/certificate', () => {
  it('returns 202 and triggers a sync pass', () => {
    const response = POST();
    expect(response.status).toBe(HTTP_ACCEPTED);
    expect(notify).toHaveBeenCalledOnce();
  });
});
