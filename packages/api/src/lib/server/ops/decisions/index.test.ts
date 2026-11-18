import { describe, expect, it, vi } from 'vitest';

import type { Db } from '@zamfono/shared';
import { seedSettings } from '@zamfono/shared/testDb.js';

import { getCoreClient, type CoreClient } from '#lib/server/coreClient.js';
import { blfEntries } from '#lib/server/provisioning/ringotelRoster.js';
import { stubCoreClient } from '#testing/coreClientStub.js';
import { createUser } from '#testing/fixtures.js';
import {
  admin,
  createUserActor,
  getForwarding,
  setForwarding
} from '#testing/forwardingTestKit.js';
import { asConfirmedRun, asRun, makeTestDb } from '#testing/testDb.js';
import { EXTERNAL, run, seedAudio } from '#testing/undoKit.js';

import { runOperation } from '../runner.js';
import { Conflict } from '../types.js';

import '../audit/index.js';
import '../dids/index.js';
import '../menus/index.js';
import '../search/index.js';
import '../users/index.js';
import './index.js';

vi.mock('#lib/server/coreClient.js', async importOriginal => ({
  ...(await importOriginal<typeof import('#lib/server/coreClient.js')>()),
  getCoreClient: vi.fn()
}));

type DecisionOut = {
  id: string;
  name: string;
  ext: string | null;
  cases: { when: unknown[]; target: unknown }[];
  default: unknown;
};

const FROM_VIENNA = { type: 'caller', number: '+43', isPrefix: true };

async function arrange(): Promise<Db> {
  const db = await makeTestDb();
  await seedSettings(db);
  return db;
}

function createDecision(
  db: Db,
  input: Record<string, unknown> = {}
): Promise<DecisionOut> {
  return run<DecisionOut>(db, 'decisions.create', {
    name: 'Main line',
    cases: [{ when: [FROM_VIENNA], target: EXTERNAL }],
    default: { kind: 'hangup' },
    ...input
  });
}

describe('decisions (§10.3 "Decisions")', () => {
  it('creates one with its cases and default, no extension unless given, and reads it back', async () => {
    const db = await arrange();
    const userId = await createUser(db, '101');
    const decision = await createDecision(db, {
      cases: [
        {
          when: [
            {
              type: 'any',
              conditions: [
                { type: 'callerUser', userId },
                { type: 'presence', userId, status: ['away'] }
              ]
            },
            { type: 'not', condition: { type: 'callerUser' } }
          ],
          target: { kind: 'user', userId }
        }
      ]
    });

    expect(decision.ext).toBeNull();
    expect(decision.cases[0]?.when).toEqual([
      {
        type: 'any',
        conditions: [
          { type: 'callerUser', userId },
          { type: 'presence', userId, status: ['away'] }
        ]
      },
      { type: 'not', condition: { type: 'callerUser', userId: null } }
    ]);
    expect(decision.default).toEqual({
      kind: 'hangup',
      announcementAudioId: null
    });
    expect(await run(db, 'decisions.get', { id: decision.id })).toEqual(
      decision
    );
  });

  it.each([
    ['an empty when', [{ when: [], target: EXTERNAL }]],
    [
      'a range mixing one-off and yearly dates',
      [
        {
          when: [
            { type: 'dates', ranges: [{ from: '2026-12-24', to: '01-06' }] }
          ],
          target: EXTERNAL
        }
      ]
    ],
    [
      'an impossible date',
      [
        {
          when: [{ type: 'dates', ranges: [{ from: '02-30', to: '03-01' }] }],
          target: EXTERNAL
        }
      ]
    ],
    [
      'isPrefix without a number',
      [
        {
          when: [{ type: 'caller', number: null, isPrefix: true }],
          target: EXTERNAL
        }
      ]
    ],
    [
      'an empty number',
      [{ when: [{ type: 'caller', number: '' }], target: EXTERNAL }]
    ],
    [
      'no status',
      [
        {
          when: [{ type: 'presence', userId: 'u', status: [] }],
          target: EXTERNAL
        }
      ]
    ],
    [
      'an interval across midnight',
      [
        {
          when: [
            {
              type: 'schedule',
              intervals: [{ weekday: 1, opens: '22:00', closes: '02:00' }]
            }
          ],
          target: EXTERNAL
        }
      ]
    ],
    [
      'operators nested deeper than 32',
      [
        {
          when: [
            Array.from({ length: 32 }).reduce<Record<string, unknown>>(
              condition => ({ type: 'not', condition }),
              { type: 'callerUser' }
            )
          ],
          target: EXTERNAL
        }
      ]
    ]
  ])('refuses %s with 422', async (_name, cases) => {
    const db = await arrange();
    await expect(createDecision(db, { cases })).rejects.toMatchObject({
      status: 422
    });
  });

  it('takes operators nested 32 deep, and refuses a user that is not live with 404', async () => {
    const db = await arrange();
    const deepest = Array.from({ length: 31 }).reduce<Record<string, unknown>>(
      condition => ({ type: 'not', condition }),
      { type: 'callerUser' }
    );
    await expect(
      createDecision(db, { cases: [{ when: [deepest], target: EXTERNAL }] })
    ).resolves.toMatchObject({ name: 'Main line' });
    await expect(
      createDecision(db, {
        name: 'Other',
        cases: [
          { when: [{ type: 'callerUser', userId: 'nobody' }], target: EXTERNAL }
        ]
      })
    ).rejects.toMatchObject({ status: 404 });
  });

  it('replaces the cases as a whole, and undo brings the earlier ones back (§5.8)', async () => {
    const db = await arrange();
    const decision = await createDecision(db);
    await run(db, 'decisions.update', {
      id: decision.id,
      cases: [],
      default: EXTERNAL
    });
    const entry = await db
      .selectFrom('auditLog')
      .select('id')
      .where('operation', '=', 'decisions.update')
      .executeTakeFirstOrThrow();
    await run(db, 'audit.undo', { id: entry.id });

    expect(await run(db, 'decisions.get', { id: decision.id })).toEqual(
      decision
    );
  });

  it('refuses the delete while a target outside it names it, its own default naming it not', async () => {
    const db = await arrange();
    const decision = await createDecision(db);
    await run(db, 'decisions.update', {
      id: decision.id,
      default: { kind: 'decision', decisionId: decision.id }
    });
    await run(db, 'dids.create', {
      number: '+4315550100',
      label: 'Main',
      target: { kind: 'decision', decisionId: decision.id }
    });
    const attempt = run(db, 'decisions.delete', { id: decision.id });
    await expect(attempt).rejects.toBeInstanceOf(Conflict);
    await expect(attempt).rejects.toMatchObject({
      references: [{ kind: 'did', label: 'Main' }]
    });
  });

  it('blocks the delete of a user its conditions name, and refuses its own undo once the user is gone (§5.8, §5.9)', async () => {
    const db = await arrange();
    const userId = await createUser(db, '101');
    const decision = await createDecision(db, {
      cases: [
        {
          when: [{ type: 'presence', userId, status: ['busy'] }],
          target: EXTERNAL
        }
      ]
    });
    const attempt = run(db, 'users.delete', { id: userId });
    await expect(attempt).rejects.toMatchObject({
      status: 409,
      references: [
        { kind: 'decision', id: decision.id, label: 'Main line (condition)' }
      ]
    });

    await run(db, 'decisions.delete', { id: decision.id });
    await run(db, 'users.delete', { id: userId });
    const entry = await db
      .selectFrom('auditLog')
      .select('id')
      .where('operation', '=', 'decisions.delete')
      .executeTakeFirstOrThrow();
    await expect(run(db, 'audit.undo', { id: entry.id })).rejects.toMatchObject(
      {
        status: 409,
        references: [{ kind: 'user', id: userId }]
      }
    );
  });

  it('gives, moves and frees an extension, found by search and titled in the roster', async () => {
    const db = await arrange();
    const decision = await createDecision(db, { extension: '650' });
    expect(decision.ext).toBe('650');
    expect(await blfEntries(db, ['650'])).toEqual([
      { number: '650', title: 'Main line' }
    ]);
    await expect(
      run(db, 'menus.create', {
        name: 'Menu',
        audioId: await seedAudio(db, 'announcement'),
        fallbackTarget: EXTERNAL,
        extension: '650'
      })
    ).rejects.toMatchObject({
      status: 409,
      references: [{ kind: 'decision', id: decision.id }]
    });

    const moved = await run<DecisionOut>(db, 'decisions.update', {
      id: decision.id,
      extension: '651'
    });
    expect(moved.ext).toBe('651');

    const anna = await createUserActor(db, 'Anna Huber', '101');
    const search = (text: string, actor = admin) =>
      runOperation(
        db,
        'search.query',
        // eslint-disable-next-line id-length -- 'q' is the wire query-parameter name fixed by §10.3's `GET /search?q=`
        { q: text },
        asRun({ actor })
      ) as Promise<{
        items: { kind: string; matched: string }[];
      }>;
    expect((await search('651', anna)).items).toEqual([
      expect.objectContaining({ kind: 'decision', matched: 'ext' })
    ]);
    await run(db, 'decisions.update', { id: decision.id, extension: null });
    // Without an extension a user finds nothing to dial; an admin still finds it.
    expect((await search('main', anna)).items).toEqual([]);
    expect((await search('main')).items).toEqual([
      expect.objectContaining({ kind: 'decision', matched: 'name' })
    ]);
  });

  it('shows a user a decision target in their own forwarding as the admin marker, kept by sending it back', async () => {
    const db = await arrange();
    const anna = await createUserActor(db, 'Anna Huber', '101');
    const decision = await createDecision(db);
    await setForwarding(
      db,
      anna.id,
      [
        {
          condition: 'noAnswer',
          target: { kind: 'decision', decisionId: decision.id }
        }
      ],
      admin
    );

    const read = await getForwarding(db, anna.id, anna);
    expect(read.rules).toEqual([
      { condition: 'noAnswer', target: { managed: true, kind: 'decision' } }
    ]);
    await setForwarding(
      db,
      anna.id,
      [
        ...read.rules,
        {
          condition: 'busy',
          target: { kind: 'mailboxUser', userId: anna.id }
        }
      ],
      anna
    );
    expect((await getForwarding(db, anna.id)).rules).toContainEqual({
      condition: 'noAnswer',
      target: {
        kind: 'decision',
        decisionId: decision.id,
        announcementAudioId: null
      }
    });
    await expect(
      setForwarding(
        db,
        anna.id,
        [
          {
            condition: 'dnd',
            target: { kind: 'decision', decisionId: decision.id }
          }
        ],
        anna
      )
    ).rejects.toMatchObject({ status: 403 });
  });

  it('dry-runs in core, answering with the targets in their wire shape', async () => {
    const db = await arrange();
    const userId = await createUser(db, '101');
    const decision = await createDecision(db, {
      cases: [{ when: [FROM_VIENNA], target: { kind: 'user', userId } }]
    });
    const caseTarget = await db
      .selectFrom('decisionCases')
      .select('targetId')
      .executeTakeFirstOrThrow();
    const decisionDryRun = vi.fn<CoreClient['decisionDryRun']>(() =>
      Promise.resolve({
        evaluations: [
          {
            decisionId: decision.id,
            decisionCase: 0,
            targetId: caseTarget.targetId,
            cases: [[{ type: 'caller' as const, matched: true, value: {} }]]
          }
        ],
        loop: null,
        invalid: null,
        ooo: null,
        hours: null
      })
    );
    vi.mocked(getCoreClient).mockReturnValue(
      stubCoreClient({ decisionDryRun })
    );

    const result = await runOperation(
      db,
      'decisions.dryRun',
      {
        id: decision.id,
        at: '2026-11-18T18:05',
        caller: { number: '+436991234567' }
      },
      asConfirmedRun()
    );

    expect(decisionDryRun).toHaveBeenCalledWith(decision.id, {
      // The tenant's zone is UTC unless set.
      at: '2026-11-18T18:05:00.000Z',
      caller: { number: '+436991234567' },
      direction: 'inbound',
      presence: {},
      values: {}
    });
    expect(result).toMatchObject({
      evaluations: [
        { name: 'Main line', decisionCase: 0, target: { kind: 'user', userId } }
      ],
      target: { kind: 'user', userId },
      loop: null
    });
  });
});

describe('menu extensions', () => {
  it('takes none unless given, and frees one with the delete, back with its undo', async () => {
    const db = await arrange();
    const audioId = await seedAudio(db, 'announcement');
    const plain = await run<{ ext: string | null }>(db, 'menus.create', {
      name: 'Plain',
      audioId,
      fallbackTarget: EXTERNAL
    });
    expect(plain.ext).toBeNull();
    const menu = await run<{ id: string; ext: string | null }>(
      db,
      'menus.create',
      { name: 'Main', audioId, fallbackTarget: EXTERNAL, extension: '660' }
    );
    expect(menu.ext).toBe('660');

    await run(db, 'menus.delete', { id: menu.id });
    expect(await db.selectFrom('extensions').select('ext').execute()).toEqual(
      []
    );
    const entry = await db
      .selectFrom('auditLog')
      .select('id')
      .where('operation', '=', 'menus.delete')
      .executeTakeFirstOrThrow();
    await run(db, 'audit.undo', { id: entry.id });
    expect(
      (await run<{ ext: string | null }>(db, 'menus.get', { id: menu.id })).ext
    ).toBe('660');
  });
});
