/**
 * The ring-group, menu, audio, out-of-office and opening-hours operations against the API's
 * rules. Kept beside the schedule components rather than under `ops/areas/`, whose glob would
 * load a test file into the app.
 */
import { beforeEach, describe, expect, it } from 'vitest';

import '#lib/api/ops/index.js';

import { ApiError } from '#lib/api/errors.js';
import {
  call,
  ConfirmationRequired,
  type Actor,
  type CallOptions
} from '#lib/api/ops/core.js';
import { AUDIO, MENU, OOO, RG, U } from '#lib/api/seed/ids.js';
import { resetDb, store } from '#lib/api/store.svelte.js';
import type { Menu, OooRule, OpeningHours, RingGroup } from '#lib/api/types.js';

const jonas: Actor = { id: U.jonas, name: 'Jonas Weber', role: 'admin' };
const mira: Actor = { id: U.mira, name: 'Mira Kovač', role: 'user' };
const as = (actor: Actor, confirmed = true): CallOptions => ({
  actor,
  channel: 'ui',
  confirmed
});

function refusal(run: () => unknown): ApiError {
  try {
    run();
  } catch (error) {
    if (error instanceof ApiError) {
      return error;
    }
    throw error;
  }
  throw new Error('expected a refusal');
}

const DAY_MS = 86_400_000;
const inDays = (days: number): string =>
  new Date(Date.now() + days * DAY_MS).toISOString();

beforeEach(() => {
  resetDb();
});

describe('ringGroups', () => {
  it('assigns the lowest free extension on create', () => {
    const group = call<RingGroup>(
      'ringGroups.create',
      { name: 'Lager', strategy: 'simultaneous' },
      as(jonas)
    );
    expect(group.ext).toBe('005');
    expect(group.ringTimeoutS).toBe(20);
    expect(group.mailboxMaxMessages).toBe(100);
  });

  it('refuses a taken name with 409 and an audio asset of the wrong kind with 422', () => {
    expect(
      refusal(() =>
        call(
          'ringGroups.create',
          { name: 'Empfang', strategy: 'random' },
          as(jonas)
        )
      ).status
    ).toBe(409);
    const wrongKind = refusal(() =>
      call(
        'ringGroups.update',
        { id: RG.empfang, mohAudioId: AUDIO.annMenu },
        as(jonas)
      )
    );
    expect([wrongKind.status, wrongKind.code]).toEqual([
      422,
      'groups.audioKind'
    ]);
  });

  it('refuses a delete while a target elsewhere points at the group, not for its own rules', () => {
    const blocked = refusal(() =>
      call('ringGroups.delete', { id: RG.support }, as(jonas))
    );
    expect(blocked.code).toBe('inUse');
    expect(blocked.refs.some(ref => ref.kind === 'did')).toBe(true);
    expect(
      blocked.refs.some(
        ref => ref.kind === 'ringGroup' && ref.id === RG.support
      )
    ).toBe(false);
  });

  it('asks before deleting', () => {
    const group = call<RingGroup>(
      'ringGroups.create',
      { name: 'Lager', strategy: 'simultaneous' },
      as(jonas)
    );
    expect(() =>
      call('ringGroups.delete', { id: group.id }, as(jonas, false))
    ).toThrow(ConfirmationRequired);
    call('ringGroups.delete', { id: group.id }, as(jonas));
    expect(
      call<RingGroup>(
        'ringGroups.create',
        { name: 'Lager', strategy: 'simultaneous' },
        as(jonas)
      ).ext
    ).toBe('005');
  });

  it('takes one forwarding rule per condition', () => {
    const rules = [
      {
        condition: 'unanswered',
        target: { kind: 'ringGroup', ringGroupId: RG.empfang }
      },
      {
        condition: 'unanswered',
        target: { kind: 'ringGroup', ringGroupId: RG.beratung }
      }
    ];
    expect(
      refusal(() =>
        call('ringGroups.setForwarding', { id: RG.support, rules }, as(jonas))
      ).code
    ).toBe('groups.duplicateCondition');
  });

  it('is for admins only', () => {
    expect(refusal(() => call('ringGroups.list', {}, as(mira))).code).toBe(
      'forbiddenRole'
    );
  });
});

describe('menus', () => {
  it('needs an announcement as greeting', () => {
    const input = {
      name: 'Neu',
      audioId: AUDIO.mohJazz,
      fallbackTarget: { kind: 'ringGroup', ringGroupId: RG.empfang }
    };
    expect(refusal(() => call('menus.create', input, as(jonas))).code).toBe(
      'groups.audioKind'
    );
    const menu = call<Menu>(
      'menus.create',
      { ...input, audioId: AUDIO.annMenu },
      as(jonas)
    );
    expect([
      menu.timeoutS,
      menu.maxAttempts,
      menu.allowExtensionDialing,
      menu.targets
    ]).toEqual([5, 3, false, []]);
  });

  it('takes key strings of 0-9 * # once each, stored by digits', () => {
    const target = { kind: 'ringGroup', ringGroupId: RG.empfang };
    expect(
      refusal(() =>
        call(
          'menus.setTargets',
          { id: MENU.haupt, targets: [{ digits: '1a', target }] },
          as(jonas)
        )
      ).code
    ).toBe('groups.digits');
    expect(
      refusal(() =>
        call(
          'menus.setTargets',
          {
            id: MENU.haupt,
            targets: [
              { digits: '1', target },
              { digits: '1', target }
            ]
          },
          as(jonas)
        )
      ).code
    ).toBe('groups.duplicateDigits');
    const saved = call<{ targets: { digits: string }[] }>(
      'menus.setTargets',
      {
        id: MENU.haupt,
        targets: [
          { digits: '#', target },
          { digits: '*9', target },
          { digits: '2', target }
        ]
      },
      as(jonas)
    );
    expect(saved.targets.map(option => option.digits)).toEqual([
      '#',
      '*9',
      '2'
    ]);
  });

  it('refuses a delete while a number dials the menu', () => {
    expect(
      refusal(() =>
        call('menus.delete', { id: MENU.haupt }, as(jonas))
      ).refs.map(ref => ref.kind)
    ).toContain('did');
  });
});

describe('audio', () => {
  const upload = {
    filename: 'ansage.mp3',
    mimeType: 'audio/mpeg',
    sizeBytes: 120_000,
    durationS: 7.4
  };

  it('takes WAV and MP3 only', () => {
    expect(
      refusal(() =>
        call(
          'audio.create',
          {
            kind: 'announcement',
            label: 'X',
            upload: { ...upload, mimeType: 'audio/ogg' }
          },
          as(jonas)
        )
      ).code
    ).toBe('groups.uploadType');
    expect(
      call<{ durationS: number }>(
        'audio.create',
        { kind: 'announcement', label: 'X', upload },
        as(jonas)
      ).durationS
    ).toBe(7);
  });

  it('refuses a delete while anything plays the asset', () => {
    const refs = refusal(() =>
      call('audio.delete', { id: AUDIO.mohLounge }, as(jonas))
    ).refs;
    expect(refs.map(ref => ref.kind).toSorted()).toEqual([
      'ringGroup',
      'settings'
    ]);
    expect(
      refusal(() =>
        call('audio.delete', { id: AUDIO.annClosed }, as(jonas))
      ).refs.map(ref => ref.kind)
    ).toEqual(['openingHours']);
    expect(() =>
      call('audio.delete', { id: AUDIO.mohAmbient }, as(jonas))
    ).not.toThrow();
  });
});

describe('ooo', () => {
  const target = { kind: 'mailboxUser', userId: U.mira };

  it('lets a user manage their own scope only, without admin targets', () => {
    call(
      'ooo.create',
      {
        scope: { kind: 'user', id: U.mira },
        startsAt: inDays(1),
        expiresAt: inDays(3),
        target
      },
      as(mira)
    );
    expect(
      refusal(() => call('ooo.list', { scope: { kind: 'tenant' } }, as(mira)))
        .code
    ).toBe('forbiddenNotOwn');
    expect(
      refusal(() =>
        call('ooo.update', { id: OOO.holidays, active: false }, as(mira))
      ).code
    ).toBe('forbiddenNotOwn');
    const sip = { kind: 'external', external: '+4917155501234', record: true };
    expect(
      refusal(() =>
        call(
          'ooo.create',
          {
            scope: { kind: 'user', id: U.mira },
            startsAt: inDays(10),
            target: sip
          },
          as(mira)
        )
      ).code
    ).toBe('groups.adminTarget');
  });

  it('refuses overlapping active periods and an end before the start', () => {
    const scope = { kind: 'user', id: U.mira };
    call(
      'ooo.create',
      { scope, startsAt: inDays(1), expiresAt: inDays(5), target },
      as(mira)
    );
    expect(
      refusal(() =>
        call(
          'ooo.create',
          { scope, startsAt: inDays(4), expiresAt: inDays(8), target },
          as(mira)
        )
      ).code
    ).toBe('groups.oooOverlap');
    expect(() =>
      call(
        'ooo.create',
        {
          scope,
          active: false,
          startsAt: inDays(4),
          expiresAt: inDays(8),
          target
        },
        as(mira)
      )
    ).not.toThrow();
    expect(
      refusal(() =>
        call(
          'ooo.create',
          { scope, startsAt: inDays(9), expiresAt: inDays(8), target },
          as(mira)
        )
      ).code
    ).toBe('groups.oooOrder');
    // An open-ended period overlaps every later one.
    call(
      'ooo.create',
      { scope, startsAt: inDays(20), expiresAt: null, target },
      as(mira)
    );
    expect(
      refusal(() =>
        call(
          'ooo.create',
          { scope, startsAt: inDays(60), expiresAt: inDays(61), target },
          as(mira)
        )
      ).code
    ).toBe('groups.oooOverlap');
  });

  it('emits an ooo event for a scope whose rule takes effect', () => {
    const before = store.db.events.length;
    call<OooRule>(
      'ooo.create',
      {
        scope: { kind: 'user', id: U.mira },
        startsAt: null,
        expiresAt: inDays(1),
        target
      },
      as(mira)
    );
    const event = store.db.events[0];
    expect(store.db.events.length).toBeGreaterThan(before);
    expect(event).toMatchObject({
      type: 'ooo',
      scope: `user:${U.mira}`,
      active: true,
      startsAt: null
    });
  });
});

describe('hours', () => {
  const closedTarget = { kind: 'mailboxUser', userId: U.mira };
  const scope = { kind: 'user', id: U.mira };

  it('validates intervals as the API does and sorts them', () => {
    const set = (intervals: unknown[]) =>
      call<OpeningHours>(
        'hours.set',
        { scope, closedTarget, intervals },
        as(mira)
      );
    expect(
      refusal(() => set([{ weekday: 8, opens: '08:00', closes: '12:00' }])).code
    ).toBe('groups.weekday');
    expect(
      refusal(() => set([{ weekday: 1, opens: '18:00', closes: '08:00' }])).code
    ).toBe('groups.hoursMidnight');
    expect(
      refusal(() => set([{ weekday: 1, opens: '8:00', closes: '12:00' }])).code
    ).toBe('groups.hoursTime');
    expect(
      refusal(() =>
        set([
          { weekday: 1, opens: '08:00', closes: '12:00' },
          { weekday: 1, opens: '08:00', closes: '10:00' }
        ])
      ).code
    ).toBe('groups.hoursDuplicate');
    const saved = set([
      { weekday: 2, opens: '13:00', closes: '24:00' },
      { weekday: 1, opens: '08:00', closes: '12:00' }
    ]);
    expect(saved.intervals.map(interval => interval.weekday)).toEqual([1, 2]);
  });

  it('keeps one schedule per scope and removes it on delete', () => {
    call('hours.set', { scope, closedTarget, intervals: [] }, as(mira));
    call(
      'hours.set',
      { scope, active: false, closedTarget, intervals: [] },
      as(mira)
    );
    expect(
      store.db.openingHours.filter(
        row => row.deletedAt === null && row.scope.kind === 'user'
      )
    ).toHaveLength(1);
    call('hours.delete', { scope }, as(mira));
    expect(
      call<{ schedule: null }>('hours.get', { scope }, as(mira)).schedule
    ).toBeNull();
    expect(refusal(() => call('hours.delete', { scope }, as(mira))).code).toBe(
      'groups.noSchedule'
    );
  });

  it('refuses another scope to a user', () => {
    expect(
      refusal(() =>
        call(
          'hours.get',
          { scope: { kind: 'ringGroup', id: RG.support } },
          as(mira)
        )
      ).code
    ).toBe('forbiddenNotOwn');
  });
});
