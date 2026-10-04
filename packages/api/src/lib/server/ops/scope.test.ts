import { describe, expect, it } from 'vitest';

import { nowIso } from '@zamfono/shared';

import { asRun, makeTestDb } from '#lib/server/testDb.js';

import { runOperation } from './runner.js';

import './hours/index.js';
import './ooo/index.js';

const TARGET = { kind: 'external', external: '+491234567' };

/** Every scope-addressed operation, with the input it takes for `scope`. */
const OPERATIONS: [string, (scope: unknown) => unknown][] = [
  ['ooo.create', scope => ({ scope, target: TARGET })],
  ['ooo.list', scope => ({ scope })],
  ['hours.set', scope => ({ scope, closedTarget: TARGET, intervals: [] })],
  ['hours.get', scope => ({ scope })],
  ['hours.delete', scope => ({ scope })]
];

const UNKNOWN_SCOPES = [
  { kind: 'user', id: 'nobody' },
  { kind: 'ringGroup', id: 'nothing' },
  { kind: 'menu', id: 'nothing' }
];

describe('a scope that does not exist (§10.3 "Out of Office", "Opening hours")', () => {
  it.each(OPERATIONS)(
    '%s answers 404 for an unknown id',
    async (name, input) => {
      const db = await makeTestDb();
      await Promise.all(
        UNKNOWN_SCOPES.map(scope =>
          expect(
            runOperation(db, name, input(scope), asRun({ confirm: true }))
          ).rejects.toMatchObject({ status: 404 })
        )
      );
    }
  );

  it.each(OPERATIONS)(
    '%s answers 404 for a soft-deleted user',
    async (name, input) => {
      const db = await makeTestDb();
      await db
        .updateTable('users')
        .set({ deletedAt: nowIso() })
        .where('id', '=', 'owner')
        .execute();
      await expect(
        runOperation(
          db,
          name,
          input({ kind: 'user', id: 'owner' }),
          asRun({ confirm: true })
        )
      ).rejects.toMatchObject({ status: 404 });
    }
  );

  it.each([
    ['ooo.update', (id: string) => ({ id, active: false })],
    ['ooo.delete', (id: string) => ({ id })]
  ])(
    '%s answers 404 for a rule whose user was soft-deleted',
    async (name, input) => {
      const db = await makeTestDb();
      const { id } = (await runOperation(
        db,
        'ooo.create',
        { scope: { kind: 'user', id: 'owner' }, target: TARGET },
        asRun()
      )) as { id: string };
      await db
        .updateTable('users')
        .set({ deletedAt: nowIso() })
        .where('id', '=', 'owner')
        .execute();
      await expect(
        runOperation(db, name, input(id), asRun({ confirm: true }))
      ).rejects.toMatchObject({ status: 404 });
    }
  );
});
