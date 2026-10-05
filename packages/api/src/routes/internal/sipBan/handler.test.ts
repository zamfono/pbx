import { describe, expect, it, vi } from 'vitest';

import { HTTP_BAD_REQUEST, HTTP_NO_CONTENT } from '@zamfono/shared';

import { recordSipBan } from '#lib/server/sipBanReport.js';
import { jsonPost } from '#testing/requestEvent.js';

import { POST } from './+server.js';

vi.mock('#lib/server/db.js', () => ({ getDb: vi.fn(() => ({})) }));
vi.mock('#lib/server/sipBanReport.js', () => ({
  recordSipBan: vi.fn(() => Promise.resolve(null))
}));

const URL = 'http://internal/internal/sipBan';

describe('POST /internal/sipBan', () => {
  it('records the report and answers 204', async () => {
    const response = await POST(
      jsonPost(URL, { address: '203.0.113.7', failures: 10 })
    );
    expect(response.status).toBe(HTTP_NO_CONTENT);
    expect(vi.mocked(recordSipBan).mock.calls[0]?.[2]).toEqual({
      address: '203.0.113.7',
      failures: 10
    });
  });

  it.each([
    [{ address: '203.0.113.7' }],
    [{ address: '203.0.113.7', failures: 0 }],
    [{ failures: 10 }],
    [{ address: '203.0.113.0/24', failures: 10 }],
    [{ address: '203.0.113.7\n198.51.100.1', failures: 10 }]
  ])('answers 400 for %j', async body => {
    const response = await POST(jsonPost(URL, body));
    expect(response.status).toBe(HTTP_BAD_REQUEST);
  });
});
