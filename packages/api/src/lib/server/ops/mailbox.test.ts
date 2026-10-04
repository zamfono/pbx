import { describe, expect, it } from 'vitest';

import { seedSettings } from '@zamfono/shared/testDb.js';

import { asRun, makeTestDb } from '#testing/testDb.js';

import { runOperation } from './runner.js';

import './ringGroups/index.js';
import './users/index.js';

type Mailbox = { id: string; mailboxMaxMessages: number | null };

/** Creates the owner of a mailbox of either kind and returns its wire shape. */
async function createOwner(
  db: Awaited<ReturnType<typeof makeTestDb>>,
  kind: 'users' | 'ringGroups'
): Promise<Mailbox> {
  if (kind === 'users') {
    const out = (await runOperation(
      db,
      'users.create',
      { name: 'Anna Huber', email: 'anna@x.test', extension: '101' },
      asRun()
    )) as { user: Mailbox };
    return out.user;
  }
  return (await runOperation(
    db,
    'ringGroups.create',
    { name: 'Sales', strategy: 'simultaneous' },
    asRun()
  )) as Mailbox;
}

describe.each(['users', 'ringGroups'] as const)(
  "%s: the mailbox's message limit (§11.5)",
  kind => {
    it('is 100 by default, any positive count when set, and null for no limit', async () => {
      const db = await makeTestDb();
      await seedSettings(db);
      const created = await createOwner(db, kind);
      expect(created.mailboxMaxMessages).toBe(100);

      const raised = (await runOperation(
        db,
        `${kind}.update`,
        { id: created.id, mailboxMaxMessages: 1_000_000 },
        asRun()
      )) as Mailbox | { user: Mailbox };
      const raisedOut = 'user' in raised ? raised.user : raised;
      expect(raisedOut.mailboxMaxMessages).toBe(1_000_000);

      const unlimited = (await runOperation(
        db,
        `${kind}.update`,
        { id: created.id, mailboxMaxMessages: null },
        asRun()
      )) as Mailbox | { user: Mailbox };
      const unlimitedOut = 'user' in unlimited ? unlimited.user : unlimited;
      expect(unlimitedOut.mailboxMaxMessages).toBeNull();
    });

    it.each([0, -1, 1.5])('refuses a limit of %s with 422', async value => {
      const db = await makeTestDb();
      await seedSettings(db);
      const created = await createOwner(db, kind);
      await expect(
        runOperation(
          db,
          `${kind}.update`,
          { id: created.id, mailboxMaxMessages: value },
          asRun()
        )
      ).rejects.toMatchObject({ status: 422 });
    });
  }
);
