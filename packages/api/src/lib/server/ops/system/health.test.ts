import { describe, expect, it, vi } from 'vitest';

import { HTTP_FORBIDDEN, type UserRole } from '@zamfono/shared';
import { MIGRATIONS_DIR, seedSettings } from '@zamfono/shared/testDb.js';

import { makeTestDb } from '#testing/testDb.js';

import { runOperation, type RunInput } from '../runner.js';

import '../index.js';

vi.stubEnv('MIGRATIONS_DIR', MIGRATIONS_DIR);
vi.stubEnv('SECRETBOX_KEY', `1:${Buffer.alloc(32, 7).toString('base64')}`);

function as(role: UserRole): RunInput {
  return {
    actor: { id: role, name: role, role },
    channel: 'mcp',
    requestId: 'req-1'
  };
}

describe('system.health (§10.3 "System")', () => {
  it.each(['admin', 'owner'] as const)(
    'answers %s the full health document /healthz computes',
    async role => {
      const db = await makeTestDb();
      await seedSettings(db);
      const document = await runOperation(db, 'system.health', {}, as(role));
      expect(document).toMatchObject({
        // core does not answer here, nor runs the ban helper.
        status: 'fail',
        checks: {
          'database:status': [{ status: 'pass' }],
          'core:reachable': [{ status: 'fail' }],
          'sipBan:helper': [{ status: 'fail' }],
          'trunks:emergency': [{ status: 'fail' }],
          'update:automatic': [{ status: 'pass' }]
        }
      });
    }
  );

  it('refuses a user with 403', async () => {
    const db = await makeTestDb();
    await expect(
      runOperation(db, 'system.health', {}, as('user'))
    ).rejects.toMatchObject({ status: HTTP_FORBIDDEN });
  });
});
