import { describe, expect, it } from 'vitest';

import { makeTestDb } from '../../testDb.js';
import { runOperation, type RunInput } from '../runner.js';
import { Conflict, type Actor } from '../types.js';

import './index.js';

const owner: Actor = { id: 'owner', name: 'Owner', role: 'owner' };

function asRun(overrides: Partial<RunInput> = {}): RunInput {
  return { actor: owner, channel: 'rest', requestId: 'req-1', ...overrides };
}

describe('blockedNumbers', () => {
  it('creates, lists and deletes a blocked number', async () => {
    const db = await makeTestDb();
    const created = await runOperation<unknown, { id: string; number: string }>(
      db,
      'blockedNumbers.create',
      { number: '+491234567', label: 'Nuisance caller' },
      asRun()
    );
    const listed = await runOperation<unknown, { items: { id: string }[] }>(
      db,
      'blockedNumbers.list',
      {},
      asRun()
    );
    expect(listed.items.map(item => item.id)).toContain(created.id);
    await runOperation(
      db,
      'blockedNumbers.delete',
      { id: created.id },
      asRun({ confirm: true })
    );
    const afterDelete = await runOperation<
      unknown,
      { items: { id: string }[] }
    >(db, 'blockedNumbers.list', {}, asRun());
    expect(afterDelete.items).toHaveLength(0);
  });

  it('refuses a duplicate live number/prefix pair', async () => {
    const db = await makeTestDb();
    await runOperation(
      db,
      'blockedNumbers.create',
      { number: '+491234567', isPrefix: true },
      asRun()
    );
    await expect(
      runOperation(
        db,
        'blockedNumbers.create',
        { number: '+491234567', isPrefix: true },
        asRun()
      )
    ).rejects.toThrow(Conflict);
  });
});
