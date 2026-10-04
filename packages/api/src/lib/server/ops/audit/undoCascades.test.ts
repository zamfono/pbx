import { describe, it } from 'vitest';

import type { Db } from '@zamfono/shared';

import { createTrunk, createUser } from '#testing/fixtures.js';
import {
  expectUndoRestores,
  ringotelDevice,
  run,
  type UndoCase
} from '#testing/undoKit.js';

import '../devices/index.js';
import '../dids/index.js';
import '../outboundRoutes/index.js';
import '../parking/index.js';
import '../settings/index.js';
import '../ringGroups/index.js';
import '../trunks/index.js';
import '../userGroups/index.js';
import '../users/index.js';
import './index.js';

/** Anna at 101 with a ringotel device whose BLF panel shows `keys`; answers her id. */
async function annaWithPanel(db: Db, keys: string[]): Promise<string> {
  const anna = await createUser(db, '101');
  await run(db, 'devices.setBlf', { id: await ringotelDevice(db, anna), keys });
  return anna;
}

// The cascades of a delete (§5.9), an extension rename, the renumbering of a list replace, and
// what each pushes to Ringotel (§10.4): its users and the branch roster.
const CASES: UndoCase[] = [
  {
    name: 'users.create joining the roster',
    arrange: () => Promise.resolve(''),
    act: async db => createUser(db, '101')
  },
  {
    name: 'devices.create provisioning a Ringotel user',
    arrange: async db => createUser(db, '101'),
    act: async (db, id) => ringotelDevice(db, id)
  },
  {
    name: 'devices.delete of a ringotel device',
    arrange: async db => ringotelDevice(db, await createUser(db, '101')),
    act: async (db, id) => run(db, 'devices.delete', { id })
  },
  {
    name: 'users.delete with devices, BLF keys and memberships',
    arrange: async db => {
      const ben = await createUser(db, '102', { name: 'Ben' });
      const anna = await annaWithPanel(db, ['102']);
      await run(db, 'devices.setBlf', {
        id: await ringotelDevice(db, ben),
        keys: ['101']
      });
      await run(db, 'ringGroups.create', {
        name: 'Sales',
        strategy: 'sequential',
        members: [
          { kind: 'user', id: ben },
          { kind: 'user', id: anna }
        ]
      });
      await run(db, 'userGroups.create', {
        name: 'Support',
        members: [{ kind: 'user', id: anna }]
      });
      return anna;
    },
    act: async (db, id) => run(db, 'users.delete', { id })
  },
  {
    name: 'users.update renaming her extension and her device',
    arrange: async db => annaWithPanel(db, ['101']),
    act: async (db, id) => run(db, 'users.update', { id, extension: '111' })
  },
  {
    name: 'users.update renaming her, on Ringotel and the roster',
    arrange: async db => annaWithPanel(db, []),
    act: async (db, id) => run(db, 'users.update', { id, name: 'Anna Berg' })
  },
  {
    name: 'ringGroups.create joining the roster',
    arrange: () => Promise.resolve(''),
    act: async db =>
      run(db, 'ringGroups.create', { name: 'Sales', strategy: 'simultaneous' })
  },
  {
    name: 'ringGroups.update renaming it on the roster',
    arrange: async db =>
      (
        await run(db, 'ringGroups.create', {
          name: 'Sales',
          strategy: 'simultaneous'
        })
      ).id,
    act: async (db, id) => run(db, 'ringGroups.update', { id, name: 'Support' })
  },
  {
    name: 'ringGroups.delete with members and a BLF key',
    arrange: async db => {
      const anna = await createUser(db, '101');
      const group = await run<{ id: string; ext: string }>(
        db,
        'ringGroups.create',
        {
          name: 'Sales',
          strategy: 'simultaneous',
          members: [{ kind: 'user', id: anna }]
        }
      );
      await run(db, 'devices.setBlf', {
        id: await ringotelDevice(db, anna),
        keys: [group.ext]
      });
      return group.id;
    },
    act: async (db, id) => run(db, 'ringGroups.delete', { id })
  },
  {
    name: 'parking.set dropping a slot a BLF key shows',
    arrange: async db => {
      await run(db, 'parking.set', { slots: ['701', '702'] });
      return annaWithPanel(db, ['702']);
    },
    act: async db => run(db, 'parking.set', { slots: ['701'] })
  },
  {
    name: 'settings.update pushing the tenant profile to Ringotel',
    arrange: () => Promise.resolve(''),
    act: async db =>
      run(db, 'settings.update', { emergencyNumbers: ['112', '110'] })
  },
  {
    name: 'trunks.setOrder renumbering the trunks',
    arrange: async db => {
      await createTrunk(db);
      await createTrunk(db, { name: 'B', hosts: [{ host: 'b.example' }] });
      return '';
    },
    act: async db => {
      const ids = await db
        .selectFrom('trunks')
        .select('id')
        .orderBy('priority', 'desc')
        .execute();
      return run(db, 'trunks.setOrder', { trunkIds: ids.map(row => row.id) });
    }
  },
  {
    name: 'outboundRoutes.replace dropping and renumbering routes',
    arrange: async db => {
      const anna = await createUser(db, '101');
      const trunkId = (await createTrunk(db)).trunk.id;
      const callerIdDidId = (
        await run(db, 'dids.create', {
          number: '+49891111',
          target: { kind: 'user', userId: anna }
        })
      ).id;
      const route = (numbers: string[]): object => ({
        trunkId,
        callerIdDidId,
        users: [anna],
        userGroups: [],
        numbers: numbers.map(number => ({ number, isPrefix: true }))
      });
      await run(db, 'outboundRoutes.replace', {
        routes: [route(['+4989']), route(['+4930']), route(['+49'])]
      });
      return trunkId;
    },
    act: async (db, trunkId) =>
      run(db, 'outboundRoutes.replace', {
        routes: [{ trunkId, users: [], userGroups: [], numbers: [] }]
      })
  }
];

describe('audit.undo after a cascade, a rename or a Ringotel push (§5.8)', () => {
  it.each(CASES)('$name', expectUndoRestores);
});
