import process from 'node:process';
import { describe, expect, it } from 'vitest';

import { HTTP_ACCEPTED, HTTP_BAD_REQUEST } from '@zamfono/shared';

import { keySpec } from '#testing/fixtures.js';
import { jsonPost } from '#testing/requestEvent.js';

import { POST } from './+server.js';

// `getDb()` and `keyringFromEnv()` read these once per process; an in-memory database with no
// migrations is enough here since the 202 case never awaits the mail send it kicks off.
process.env.DB_FILE = ':memory:';
process.env.SECRETBOX_KEY = keySpec();

describe('POST /internal/mail', () => {
  it('returns 400 for a voicemail filename that reaches outside the voicemail directory', async () => {
    const response = await POST(
      jsonPost('http://internal/internal/mail', {
        kind: 'voicemail',
        to: { userId: 'u1' },
        values: {
          callerNumber: '+491111111',
          callerName: '',
          mailboxName: 'Voicemail Owner',
          receivedAt: '2026-06-15T12:00:00.000Z',
          durationS: 12
        },
        filename: '../../etc/passwd'
      })
    );
    expect(response.status).toBe(HTTP_BAD_REQUEST);
  });

  it('returns 202 for a request with no X-Forwarded-For', async () => {
    const response = await POST(
      jsonPost('http://internal/internal/mail', {
        kind: 'missedCall',
        to: { userId: 'unknown-user' },
        values: {
          callerNumber: '+491111111',
          callerName: '',
          receivedAt: '2026-06-15T12:00:00.000Z',
          didLabel: 'Main line'
        }
      })
    );
    expect(response.status).toBe(HTTP_ACCEPTED);
  });
});
