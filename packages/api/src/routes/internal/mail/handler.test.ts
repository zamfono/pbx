import { randomBytes } from 'node:crypto';
import process from 'node:process';
import type { RequestEvent } from '@sveltejs/kit';
import { describe, expect, it } from 'vitest';

import { POST } from './+server.js';

const STATUS_BAD_REQUEST = 400;
const STATUS_ACCEPTED = 202;
const KEY_BYTE_LENGTH = 32;

// `getDb()` and `keyringFromEnv()` read these once per process; an in-memory database with no
// migrations is enough here since the 202 case never awaits the mail send it kicks off.
process.env.DB_FILE = ':memory:';
process.env.SECRETBOX_KEY = `1:${randomBytes(KEY_BYTE_LENGTH).toString('base64')}`;

/** A minimal `RequestEvent`-shaped value: the handler reads only `event.request`. */
function eventFor(request: Request): RequestEvent {
  return { request } as RequestEvent;
}

describe('POST /internal/mail', () => {
  it('returns 400 for an attachmentPath outside the voicemail media directory', async () => {
    const request = new Request('http://internal/internal/mail', {
      method: 'POST',
      body: JSON.stringify({
        kind: 'voicemail',
        to: { userId: 'u1' },
        values: {
          callerNumber: '+491111111',
          callerName: '',
          mailboxName: 'Voicemail Owner',
          receivedAt: '2026-06-15T12:00:00.000Z',
          durationS: 12
        },
        attachmentPath: '/etc/passwd'
      })
    });
    // eslint-disable-next-line new-cap -- POST is the fixed SvelteKit route-handler export name
    const response = await POST(eventFor(request));
    expect(response.status).toBe(STATUS_BAD_REQUEST);
  });

  it('returns 202 for a request with no X-Forwarded-For', async () => {
    const request = new Request('http://internal/internal/mail', {
      method: 'POST',
      body: JSON.stringify({
        kind: 'missedCall',
        to: { userId: 'unknown-user' },
        values: {
          callerNumber: '+491111111',
          callerName: '',
          receivedAt: '2026-06-15T12:00:00.000Z',
          didLabel: 'Main line'
        }
      })
    });
    // eslint-disable-next-line new-cap -- POST is the fixed SvelteKit route-handler export name
    const response = await POST(eventFor(request));
    expect(response.status).toBe(STATUS_ACCEPTED);
  });
});
