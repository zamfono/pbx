import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import '#lib/api/ops/index.js';

import { ApiError } from '#lib/api/errors.js';
import {
  NO_EMERGENCY_TRUNK_WARNING,
  SRV_DISABLED_WARNING,
  type TrunkWriteOutput
} from '#lib/api/ops/areas/trunks.js';
import { call, type Actor } from '#lib/api/ops/core.js';
import { RG, TRUNK, U } from '#lib/api/seed/ids.js';
import { resetDb, store } from '#lib/api/store.svelte.js';
import type { Trunk } from '#lib/api/types.js';

const admin: Actor = { id: U.jonas, name: 'Jonas Weber', role: 'admin' };
const as = <O>(name: string, input: unknown): O =>
  call<O>(name, input, { actor: admin, channel: 'ui', confirmed: true });

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

const ipTrunk = {
  name: 'Backup',
  emergency: false,
  authMode: 'ip',
  hosts: [{ host: 'sip.backup.example' }]
};

beforeEach(() => {
  vi.useFakeTimers();
  resetDb();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('trunks.create', () => {
  test('appends an ip trunk with the defaults', () => {
    const { trunk, warnings } = as<TrunkWriteOutput>('trunks.create', ipTrunk);
    expect(trunk.priority).toBe(2);
    expect(trunk.transport).toBe('udp');
    expect(trunk.username).toBeNull();
    expect(warnings).toEqual([]);
    expect(store.db.audit[0]?.undoable).toBe(true);
  });

  test('applies the credential rules per auth mode', () => {
    expect(
      refusal(() => as('trunks.create', { ...ipTrunk, username: 'acct' })).code
    ).toBe('trunks.credentialsNotAccepted');
    expect(
      refusal(() =>
        as('trunks.create', {
          ...ipTrunk,
          authMode: 'registration',
          username: 'acct'
        })
      ).code
    ).toBe('trunks.credentialsRequired');
    const { trunk } = as<TrunkWriteOutput>('trunks.create', {
      ...ipTrunk,
      authMode: 'registration',
      username: 'acct',
      password: 'secret'
    });
    expect(trunk.passwordSet).toBe(true);
    expect(store.db.audit[0]?.undoable).toBe(false);
  });

  test('refuses the API inconsistencies', () => {
    expect(
      refusal(() => as('trunks.create', { ...ipTrunk, srtp: true })).code
    ).toBe('trunks.srtpNeedsTls');
    expect(
      refusal(() => as('trunks.create', { ...ipTrunk, clir: true })).code
    ).toBe('trunks.clirNeedsPai');
    expect(
      refusal(() => as('trunks.create', { ...ipTrunk, callerIdHeader: 'pai' }))
        .code
    ).toBe('trunks.paiNeedsUsername');
    expect(
      refusal(() =>
        as('trunks.create', { ...ipTrunk, forwardedCallerId: 'original' })
      ).code
    ).toBe('trunks.forwardedNeedsDiversion');
    expect(
      refusal(() =>
        as('trunks.create', {
          ...ipTrunk,
          forwardedCallerId: 'original',
          diversion: 'last',
          callerIdHeader: 'both'
        })
      ).code
    ).toBe('trunks.forwardedNeedsFrom');
    expect(
      refusal(() => as('trunks.create', { ...ipTrunk, registerExpiryS: 600 }))
        .code
    ).toBe('trunks.registrationOnly');
    expect(
      refusal(() =>
        as('trunks.create', { ...ipTrunk, outboundProxy: 'proxy.example' })
      ).code
    ).toBe('trunks.outboundProxyInvalid');
    expect(
      refusal(() => as('trunks.create', { ...ipTrunk, name: 'nordwind sip' }))
        .code
    ).toBe('trunks.nameTaken');
  });

  test('checks hosts by direction', () => {
    expect(
      refusal(() =>
        as('trunks.create', { ...ipTrunk, hosts: [{ host: '2001:db8::1' }] })
      ).code
    ).toBe('trunks.hostInvalid');
    const { trunk, warnings } = as<TrunkWriteOutput>('trunks.create', {
      ...ipTrunk,
      hosts: [
        { host: '203.0.113.0/24', direction: 'inbound' },
        { host: 'sip.backup.example', port: 5060 }
      ]
    });
    expect(trunk.hosts[1]?.direction).toBe('both');
    expect(warnings).toEqual([SRV_DISABLED_WARNING]);
    expect(
      refusal(() =>
        as('trunks.create', {
          ...ipTrunk,
          name: 'Reg',
          authMode: 'registration',
          username: 'a',
          password: 'b',
          hosts: [{ host: '203.0.113.9', direction: 'inbound' }]
        })
      ).code
    ).toBe('trunks.noRegistrar');
  });

  test('keeps an inbound-auth username free as an endpoint name', () => {
    const device = store.db.devices.find(row => row.deletedAt === null);
    const taken = refusal(() =>
      as('trunks.create', {
        ...ipTrunk,
        inboundAuth: true,
        username: device?.sipUsername,
        password: 'x'
      })
    );
    expect(taken.code).toBe('trunks.usernameTaken');
    expect(
      refusal(() =>
        as('trunks.create', {
          ...ipTrunk,
          inboundAuth: true,
          username: 'trunk-1',
          password: 'x'
        })
      ).code
    ).toBe('trunks.inboundAuthUsername');
  });
});

describe('trunks.update, delete, order, reregister', () => {
  test('a password change is not undoable; clearing srtp keeps the rest', () => {
    as('trunks.update', { id: TRUNK.nordwind, password: 'new' });
    expect(store.db.audit[0]?.undoable).toBe(false);
    expect(
      refusal(() =>
        as('trunks.update', { id: TRUNK.nordwind, transport: 'udp' })
      ).code
    ).toBe('trunks.srtpNeedsTls');
    const { trunk } = as<TrunkWriteOutput>('trunks.update', {
      id: TRUNK.nordwind,
      transport: 'udp',
      srtp: false
    });
    expect(trunk.transport).toBe('udp');
    expect(store.db.audit[0]?.undoable).toBe(true);
  });

  test('switching to ip drops the credentials and registration timers', () => {
    const { trunk } = as<TrunkWriteOutput>('trunks.update', {
      id: TRUNK.nordwind,
      authMode: 'ip'
    });
    expect(trunk.username).toBeNull();
    expect(trunk.passwordSet).toBe(false);
    expect(trunk.registerExpiryS).toBeNull();
  });

  test('refuses deleting a trunk a route uses and warns when no emergency trunk is left', () => {
    const refused = refusal(() => as('trunks.delete', { id: TRUNK.nordwind }));
    expect(refused.code).toBe('trunks.inUse');
    expect(refused.refs[0]?.kind).toBe('outboundRoute');
    const { trunk } = as<TrunkWriteOutput>('trunks.create', ipTrunk);
    as('outboundRoutes.replace', {
      routes: [{ trunkId: trunk.id, users: [], userGroups: [], numbers: [] }]
    });
    const out = as<{ warnings: string[] }>('trunks.update', {
      id: TRUNK.nordwind,
      emergency: false
    });
    expect(out.warnings).toContain(NO_EMERGENCY_TRUNK_WARNING);
    expect(as<{ id: string }>('trunks.delete', { id: TRUNK.nordwind }).id).toBe(
      TRUNK.nordwind
    );
  });

  test('a sip forward target blocks the delete too', () => {
    as('dids.update', {
      id: store.db.dids[1]?.id,
      target: {
        kind: 'sip',
        trunkId: TRUNK.nordwind,
        user: 'agent',
        headers: [],
        record: false
      }
    });
    as('outboundRoutes.replace', { routes: [] });
    const refused = refusal(() => as('trunks.delete', { id: TRUNK.nordwind }));
    expect(refused.refs.map(ref => ref.kind)).toEqual(['did']);
    expect(RG.empfang).toBeTruthy();
  });

  test('setOrder names every live trunk exactly once', () => {
    const { trunk } = as<TrunkWriteOutput>('trunks.create', ipTrunk);
    expect(
      refusal(() => as('trunks.setOrder', { trunkIds: [trunk.id] })).code
    ).toBe('trunks.orderMismatch');
    as('trunks.setOrder', { trunkIds: [trunk.id, TRUNK.nordwind] });
    const order = as<{ items: Trunk[] }>('trunks.list', {}).items.map(
      row => row.id
    );
    expect(order).toEqual([trunk.id, TRUNK.nordwind]);
  });

  test('reregister is a pure action for registration trunks, reporting the new status', () => {
    as('trunks.reregister', { id: TRUNK.nordwind });
    expect(store.db.audit[0]?.undoable).toBe(false);
    vi.advanceTimersByTime(500);
    expect(store.db.trunks[0]?.status).toBe('unreachable');
    vi.advanceTimersByTime(2000);
    expect(store.db.trunks[0]?.status).toBe('registered');
    expect(store.db.events[0]?.type).toBe('trunk.status');
    const { trunk } = as<TrunkWriteOutput>('trunks.create', ipTrunk);
    expect(refusal(() => as('trunks.reregister', { id: trunk.id })).code).toBe(
      'trunks.noRegistration'
    );
  });

  test('the first trunk brings the catch-all route', () => {
    store.db.outboundRoutes = [];
    store.db.trunks[0]!.deletedAt = new Date().toISOString();
    const { trunk } = as<TrunkWriteOutput>('trunks.create', ipTrunk);
    expect(store.db.outboundRoutes).toEqual([
      expect.objectContaining({
        trunkId: trunk.id,
        users: [],
        userGroups: [],
        numbers: []
      })
    ]);
  });
});
