import { describe, it, vi } from 'vitest';

import { newId, type Db } from '@zamfono/shared';

import { createTrunk, createUser } from '#testing/fixtures.js';
import {
  expectUndoRestores,
  EXTERNAL,
  run,
  seedAudio,
  type UndoCase
} from '#testing/undoKit.js';

import '../audio/index.js';
import '../blockedNumbers/index.js';
import '../devices/index.js';
import '../didBlocks/index.js';
import '../dids/index.js';
import '../hours/index.js';
import '../menus/index.js';
import '../ooo/index.js';
import '../settings/index.js';
import '../trunks/index.js';
import '../userGroups/index.js';
import '../users/index.js';
import './index.js';

vi.mock('#lib/server/audio/store.js', () => ({
  storeAudio: vi.fn(async (kind: string) =>
    Promise.resolve({ id: newId(), filename: `${kind}.wav` })
  ),
  deleteAudioFile: vi.fn(async () => Promise.resolve())
}));

const OWNER_SCOPE = { kind: 'user', id: 'owner' };

async function userId(db: Db, name: string): Promise<string> {
  const user = await db
    .selectFrom('users')
    .select('id')
    .where('name', '=', name)
    .executeTakeFirstOrThrow();
  return user.id;
}

/** A soft delete of what `create` made: its undo revives the row and reaches `core` again. */
function deletion(
  operation: string,
  create: (db: Db) => Promise<string>
): UndoCase {
  return {
    name: operation,
    arrange: create,
    act: async (db, id) => run(db, operation, { id })
  };
}

// The caller ID a DID write gives its user (§9.4), a reference to an audio asset, and the
// propagation each kind of soft delete owes `core` and Asterisk once revived (§3.1, §5.9).
const CASES: UndoCase[] = [
  {
    name: 'dids.create giving its target user their caller ID',
    arrange: async db => createUser(db, '101'),
    act: async (db, id) =>
      run(db, 'dids.create', {
        number: '+49891111',
        target: { kind: 'user', userId: id }
      })
  },
  {
    name: 'dids.update retargeting to a user without caller ID',
    arrange: async db => {
      await createUser(db, '101', { name: 'Anna' });
      return (
        await run(db, 'dids.create', { number: '+49891111', target: EXTERNAL })
      ).id;
    },
    act: async (db, id) =>
      run(db, 'dids.update', {
        id,
        target: { kind: 'user', userId: await userId(db, 'Anna') }
      })
  },
  {
    name: 'settings.update pointing hold music at an asset',
    arrange: async db => seedAudio(db, 'moh'),
    act: async (db, id) => run(db, 'settings.update', { holdMohAudioId: id })
  },
  {
    name: 'menus.update replacing its greeting',
    arrange: async db => {
      const greeting = await seedAudio(db, 'announcement');
      await seedAudio(db, 'announcement');
      return (
        await run(db, 'menus.create', {
          name: 'Main',
          audioId: greeting,
          fallbackTarget: EXTERNAL
        })
      ).id;
    },
    act: async (db, id) => {
      const other = await db
        .selectFrom('audioAssets')
        .select('id')
        .where('id', 'not in', db.selectFrom('menus').select('audioId'))
        .executeTakeFirstOrThrow();
      return run(db, 'menus.update', { id, audioId: other.id });
    }
  },
  deletion(
    'dids.delete',
    async db =>
      (await run(db, 'dids.create', { number: '+49891111', target: EXTERNAL }))
        .id
  ),
  deletion(
    'menus.delete',
    async db =>
      (
        await run(db, 'menus.create', {
          name: 'Main',
          audioId: await seedAudio(db, 'announcement'),
          fallbackTarget: EXTERNAL
        })
      ).id
  ),
  deletion('audio.delete', async db => seedAudio(db, 'moh')),
  deletion(
    'blockedNumbers.delete',
    async db =>
      (await run(db, 'blockedNumbers.create', { number: '+491234567' })).id
  ),
  deletion(
    'didBlocks.delete',
    async db =>
      (await run(db, 'didBlocks.create', { base: '+49891234', digits: 2 })).id
  ),
  deletion(
    'ooo.delete',
    async db =>
      (await run(db, 'ooo.create', { scope: OWNER_SCOPE, target: EXTERNAL })).id
  ),
  deletion('trunks.delete', async db => {
    await createTrunk(db, { name: 'B', hosts: [{ host: 'b.example' }] });
    return (await createTrunk(db)).trunk.id;
  }),
  deletion(
    'userGroups.delete',
    async db =>
      (
        await run(db, 'userGroups.create', {
          name: 'Support',
          members: [{ kind: 'user', id: 'owner' }]
        })
      ).id
  ),
  {
    name: 'hours.delete',
    arrange: async db => {
      await run(db, 'hours.set', {
        scope: OWNER_SCOPE,
        closedTarget: EXTERNAL,
        intervals: []
      });
      return 'owner';
    },
    act: async db => run(db, 'hours.delete', { scope: OWNER_SCOPE })
  }
];

describe('audit.undo after a reference or propagation side effect (§5.8)', () => {
  it.each(CASES)('$name', expectUndoRestores);
});
