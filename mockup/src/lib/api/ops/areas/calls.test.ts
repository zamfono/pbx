import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import '#lib/api/ops/index.js';

import { ApiError } from '#lib/api/errors.js';
import type { Page } from '#lib/api/ops/areas/calls.js';
import { call, type Actor } from '#lib/api/ops/core.js';
import { RG, U } from '#lib/api/seed/ids.js';
import { resetDb, store } from '#lib/api/store.svelte.js';
import type { Call, LiveCall } from '#lib/api/types.js';

const lea: Actor = { id: U.lea, name: 'Lea Brandt', role: 'owner' };
const jonas: Actor = { id: U.jonas, name: 'Jonas Weber', role: 'admin' };
const mira: Actor = { id: U.mira, name: 'Mira Kovač', role: 'user' };
const felix: Actor = { id: U.felix, name: 'Dr. Felix Hartmann', role: 'owner' };

const run = <O>(
  actor: Actor,
  name: string,
  input: unknown,
  confirmed = false
): O => call<O>(name, input, { actor, channel: 'ui', confirmed });

function refusal(fn: () => unknown): ApiError {
  try {
    fn();
  } catch (error) {
    if (error instanceof ApiError) {
      return error;
    }
    throw error;
  }
  throw new Error('expected a refusal');
}

beforeEach(() => {
  resetDb();
});

describe('calls history', () => {
  it('narrows a user to their own calls', () => {
    const own = run<Page<Call>>(mira, 'calls.list', { limit: 200 }).items;
    expect(own.length).toBeGreaterThan(0);
    expect(
      own.every(row =>
        [row.callerUserId, row.calleeUserId, row.answeredByUserId].includes(
          U.mira
        )
      )
    ).toBe(true);
    expect(refusal(() => run(mira, 'calls.list', { userId: U.lea })).code).toBe(
      'forbiddenNotOwn'
    );
  });

  it('refuses a user another user’s call and lets admins read its trace', () => {
    const scenario = store.db.calls.find(
      row =>
        row.ringGroupId === RG.support &&
        row.log.some(line => line.event === 'ringTotal')
    );
    expect(scenario).toBeDefined();
    expect(
      refusal(() => run(mira, 'calls.get', { id: scenario?.id })).code
    ).toBe('forbiddenNotOwn');
    const detail = run<Call & { childCallIds: string[] }>(jonas, 'calls.get', {
      id: scenario?.id
    });
    expect(detail.status).toBe('voicemail');
    expect(
      detail.log.some(line => line.event === 'skipped' && line.reason === 'dnd')
    ).toBe(true);
  });

  it('filters by date in the tenant time zone', () => {
    const today = new Intl.DateTimeFormat('sv-SE', {
      timeZone: 'Europe/Berlin'
    }).format(new Date());
    const rows = run<Page<Call>>(jonas, 'calls.list', {
      from: today,
      to: today,
      limit: 200
    }).items;
    const others = run<Page<Call>>(jonas, 'calls.list', { limit: 200 }).items;
    expect(rows.length).toBeLessThanOrEqual(others.length);
    expect(
      refusal(() => run(jonas, 'calls.list', { from: 'yesterday' })).code
    ).toBe('instantInvalid');
  });
});

describe('live calls', () => {
  it('lets the person in the call hold, resume and hang up; others are refused', () => {
    const live = store.db.liveCalls.find(row =>
      row.userIds.includes(U.felix)
    ) as LiveCall;
    expect(
      refusal(() => run(mira, 'calls.hold', { id: live.callId })).code
    ).toBe('forbiddenNotOwn');
    expect(
      refusal(() => run(jonas, 'calls.hold', { id: live.callId })).code
    ).toBe('legRequired');
    run(felix, 'calls.hold', { id: live.callId });
    expect(
      store.db.liveCalls
        .find(row => row.callId === live.callId)
        ?.legs.some(leg => leg.state === 'held')
    ).toBe(true);
    expect(
      refusal(() => run(felix, 'calls.hold', { id: live.callId })).code
    ).toBe('held');
    run(felix, 'calls.resume', { id: live.callId });
    const before = store.db.calls.length;
    run(felix, 'calls.hangup', { id: live.callId });
    expect(store.db.liveCalls.some(row => row.callId === live.callId)).toBe(
      false
    );
    expect(store.db.calls.length).toBe(before + 1);
    const appended = store.db.calls.find(row => row.id === live.callId);
    expect(appended?.status).toBe('answered');
    expect(appended?.log.at(-1)?.event).toBe('ended');
    expect(
      store.db.events.some(event => event.type === 'history.appended')
    ).toBe(true);
  });

  it('parks on the lowest free slot and retrieves by dialling it', () => {
    const live = store.db.liveCalls.find(row =>
      row.userIds.includes(U.felix)
    ) as LiveCall;
    const parked = run<{ slot: string }>(felix, 'calls.park', {
      id: live.callId
    });
    expect(parked.slot).toBe('701');
    const list = run<Page<{ slot: string; caller: string | null }>>(
      mira,
      'parking.list',
      {}
    ).items;
    expect(list).toEqual([
      expect.objectContaining({ slot: '701', caller: '+49816155520' })
    ]);
    // Nobody is connected to a parked call: only an admin acts on it.
    expect(
      store.db.liveCalls.find(row => row.callId === live.callId)?.userIds
    ).toEqual([]);
    run(mira, 'calls.originate', { target: '701' });
    expect(store.db.parked).toHaveLength(0);
  });

  it('refuses click-to-dial for another user to a user, and without a registered device', () => {
    expect(
      refusal(() =>
        run(mira, 'calls.originate', { target: '101', userId: U.lea })
      ).code
    ).toBe('forbiddenNotOwn');
    expect(
      refusal(() =>
        run(jonas, 'calls.originate', { target: '101', userId: U.nina })
      ).code
    ).toBe('noRegisteredDevice');
    expect(
      refusal(() => run(jonas, 'calls.originate', { target: 'abc' })).code
    ).toBe('invalidTarget');
    const { callId } = run<{ callId: string }>(jonas, 'calls.originate', {
      target: '0897788990'
    });
    const live = store.db.liveCalls.find(row => row.callId === callId);
    expect(live?.direction).toBe('outbound');
    expect(live?.to).toBe('+49897788990');
  });

  it('declines only a ring of one’s own', () => {
    const live = store.db.liveCalls[0] as LiveCall;
    expect(
      refusal(() => run(mira, 'calls.decline', { id: live.callId })).code
    ).toBe('notRinging');
  });
});

describe('attended transfer', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('holds the caller, consults a colleague and joins them, the transferrer leaving', () => {
    vi.useFakeTimers();
    const live = store.db.liveCalls.find(row =>
      row.userIds.includes(U.felix)
    ) as LiveCall;
    const { callId } = run<{ callId: string }>(felix, 'calls.consult', {
      id: live.callId,
      target: '107'
    });
    expect(
      store.db.liveCalls
        .find(row => row.callId === live.callId)
        ?.legs.some(leg => leg.state === 'held')
    ).toBe(true);
    expect(
      refusal(() =>
        run(felix, 'calls.transfer', { id: live.callId, toCallId: callId })
      ).code
    ).toBe('notAnswered');
    vi.advanceTimersByTime(10_000);
    run(felix, 'calls.transfer', { id: live.callId, toCallId: callId });
    const joined = store.db.liveCalls.find(row => row.callId === live.callId);
    expect(joined?.userIds).toEqual([U.daniel]);
    expect(joined?.legs.every(leg => leg.state === 'up')).toBe(true);
    expect(store.db.liveCalls.some(row => row.callId === callId)).toBe(false);
    expect(store.db.calls.find(row => row.id === callId)?.parentCallId).toBe(
      live.callId
    );
  });
});

describe('voicemail and recordings', () => {
  it('shows a user their own and their ring groups’ mailboxes only', () => {
    const items = run<
      Page<{ mailboxUserId: string | null; mailboxRingGroupId: string | null }>
    >(mira, 'voicemails.list', { limit: 200 }).items;
    expect(items.length).toBeGreaterThan(0);
    expect(
      items.every(
        item =>
          item.mailboxUserId === U.mira ||
          [RG.empfang, RG.support].includes(item.mailboxRingGroupId ?? '')
      )
    ).toBe(true);
    expect(items[0]).not.toHaveProperty('clip');
  });

  it('deletes a voicemail permanently after confirmation, without undo', () => {
    const vm = store.db.voicemails[0];
    expect(
      refusal(() => run(lea, 'voicemails.delete', { id: vm?.id })).code
    ).toBe('confirmationRequired');
    run(lea, 'voicemails.delete', { id: vm?.id }, true);
    expect(store.db.voicemails.some(row => row.id === vm?.id)).toBe(false);
    expect(store.db.audit[0]).toMatchObject({
      operation: 'voicemails.delete',
      undoable: false
    });
  });

  it('never lets a user hear a recording, not even of their own call', () => {
    const recording = store.db.recordings[0];
    expect(refusal(() => run(mira, 'recordings.list', {})).code).toBe(
      'forbiddenRole'
    );
    expect(
      refusal(() => run(mira, 'recordings.audio', { id: recording?.id })).code
    ).toBe('forbiddenRole');
    expect(
      run<{ channels: number }>(jonas, 'recordings.audio', {
        id: recording?.id
      }).channels
    ).toBe(2);
  });
});

describe('contacts and parking slots', () => {
  it('normalises numbers and refuses duplicate labels', () => {
    const contact = run<{ phones: { label: string; number: string }[] }>(
      jonas,
      'contacts.create',
      {
        displayName: 'Steuerkanzlei Nord',
        phones: [{ label: 'Büro', number: '089 123 4567' }]
      }
    );
    expect(contact.phones[0]?.number).toBe('+49891234567');
    expect(
      refusal(() =>
        run(jonas, 'contacts.create', {
          displayName: 'X',
          phones: [
            { label: 'A', number: '+49891' },
            { label: 'A', number: '+498912345678' }
          ]
        })
      ).code
    ).toBe('contactPhoneNumber');
    expect(
      refusal(() => run(mira, 'contacts.create', { displayName: 'X' })).code
    ).toBe('forbiddenRole');
  });

  it('refuses a slot that is a user’s extension and one of the wrong length', () => {
    expect(
      refusal(() => run(jonas, 'parking.set', { slots: ['701', '101'] })).code
    ).toBe('parkingSlotTaken');
    expect(
      refusal(() => run(jonas, 'parking.set', { slots: ['7010'] })).code
    ).toBe('parkingSlotLength');
    expect(
      run<{ slots: string[] }>(jonas, 'parking.set', { slots: ['702', '701'] })
        .slots
    ).toEqual(['701', '702']);
    expect(store.db.blf.flatMap(panel => panel.keys)).not.toContain('703');
  });
});

describe('statistics and presence', () => {
  it('buckets call volume by local day and counts every top-level call once', () => {
    const from = new Date(Date.now() - 7 * 86_400_000).toISOString();
    const to = new Date().toISOString();
    const { buckets } = run<{
      buckets: { start: string; value: number | null }[];
    }>(jonas, 'stats.query', { metric: 'callVolume', from, to, bucket: 'day' });
    const total = buckets.reduce((sum, bucket) => sum + (bucket.value ?? 0), 0);
    const expected = store.db.calls.filter(
      row =>
        row.parentCallId === null && row.startedAt >= from && row.startedAt < to
    ).length;
    expect(total).toBe(expected);
    expect(
      refusal(() =>
        run(mira, 'stats.query', {
          metric: 'callVolume',
          from,
          to,
          bucket: 'day'
        })
      ).code
    ).toBe('forbiddenRole');
  });

  it('snapshots presence as of a past instant', () => {
    const { items } = run<Page<{ userId: string; status: string }>>(
      jonas,
      'presenceLog.snapshot',
      { at: new Date().toISOString(), limit: 200 }
    );
    expect(items.find(item => item.userId === U.tobias)?.status).toBe('dnd');
    expect(items.find(item => item.userId === U.felix)?.status).toBe('busy');
  });
});

describe('trunk outage', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('places no external leg while every trunk is unreachable, and says why', () => {
    vi.useFakeTimers();
    for (const trunk of store.db.trunks) {
      trunk.status = 'unreachable';
    }
    const { callId } = run<{ callId: string }>(jonas, 'calls.originate', {
      target: '0897788990'
    });
    vi.advanceTimersByTime(10_000);
    const live = store.db.liveCalls.find(row => row.callId === callId);
    expect(live?.legs.some(leg => leg.trunkId !== undefined) ?? false).toBe(
      false
    );
    const row = store.db.calls.find(candidate => candidate.id === callId);
    expect(
      row?.log.some(
        line => line.event === 'attempt' && line.result === 'trunkUnreachable'
      )
    ).toBe(true);
  });
});
