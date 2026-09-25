import { describe, expect, it } from 'vitest';

import {
  ATTEMPT_NO_RESPONSE_MS,
  callerIdHeaders,
  channelCapAllows,
  emergencyTrunks,
  matchingRoutes,
  presentedNumber,
  resolveClir,
  shouldFallThrough,
  type Route
} from './trunk.js';

const route = (overrides: Partial<Route>): Route => ({
  id: 'route-1',
  priority: 1,
  trunkId: 'trunk-1',
  calleridDidId: null,
  users: [],
  userGroups: [],
  numbers: [],
  ...overrides
});

describe('matchingRoutes', () => {
  it('returns every matching route in priority order', () => {
    const catchAll = route({ id: 'catch-all', priority: 3 });
    const groupRoute = route({
      id: 'group-route',
      priority: 1,
      userGroups: ['sales']
    });
    const prefixRoute = route({
      id: 'prefix-route',
      priority: 2,
      numbers: [{ number: '+49', isPrefix: true }]
    });

    const result = matchingRoutes(
      [catchAll, prefixRoute, groupRoute],
      { userId: 'u1', groupIds: ['sales'] },
      '+49891234'
    );

    expect(result.map(matched => matched.id)).toEqual([
      'group-route',
      'prefix-route',
      'catch-all'
    ]);
  });

  it('matches a nested member of a route user group', () => {
    const groupRoute = route({ userGroups: ['dept-parent'] });

    const result = matchingRoutes(
      [groupRoute],
      { userId: 'u1', groupIds: ['dept-child', 'dept-parent'] },
      '+49891234'
    );

    expect(result).toEqual([groupRoute]);
  });

  it('skips routes with callers for a system-dialed leg (caller null)', () => {
    const userRoute = route({ users: ['u1'] });
    const openRoute = route({ id: 'open-route' });

    const result = matchingRoutes([userRoute, openRoute], null, '+49891234');

    expect(result.map(matched => matched.id)).toEqual(['open-route']);
  });
});

describe('shouldFallThrough', () => {
  it('falls through on 503 before alerting', () => {
    expect(
      shouldFallThrough({ kind: 'final', code: 503, alerted: false })
    ).toBe(true);
  });

  it('does not fall through on 486', () => {
    expect(
      shouldFallThrough({ kind: 'final', code: 486, alerted: false })
    ).toBe(false);
  });

  it('falls through on 404', () => {
    expect(
      shouldFallThrough({ kind: 'final', code: 404, alerted: false })
    ).toBe(true);
  });

  it('does not fall through on 500 after alerting', () => {
    expect(shouldFallThrough({ kind: 'final', code: 500, alerted: true })).toBe(
      false
    );
  });

  it('does not fall through on 603', () => {
    expect(
      shouldFallThrough({ kind: 'final', code: 603, alerted: false })
    ).toBe(false);
  });

  it('falls through on noResponse', () => {
    expect(shouldFallThrough({ kind: 'noResponse' })).toBe(true);
  });

  it('falls through on a reached channel cap', () => {
    expect(shouldFallThrough({ kind: 'cap' })).toBe(true);
  });
});

describe('emergencyTrunks', () => {
  it('tries trunks in priority order, skipping unreachable ones', () => {
    const trunks = [
      { id: 'second', priority: 2, status: 'registered' as const },
      { id: 'dead', priority: 1, status: 'unreachable' as const },
      { id: 'first', priority: 3, status: 'unknown' as const }
    ];

    expect(emergencyTrunks(trunks)).toEqual(['second', 'first']);
  });
});

describe('presentedNumber', () => {
  const dids = new Map([
    ['did-route', { number: '+49890001' }],
    ['did-user', { number: '+49890002' }],
    ['did-main', { number: '+49890003' }]
  ]);

  it("prefers the route's override over the user's own number", () => {
    expect(
      presentedNumber({
        route: route({ calleridDidId: 'did-route' }),
        user: { calleridDidId: 'did-user' },
        dids,
        mainDidId: 'did-main'
      })
    ).toBe('+49890001');
  });

  it("falls back to the caller's own number when the route sets none", () => {
    expect(
      presentedNumber({
        route: route({ calleridDidId: null }),
        user: { calleridDidId: 'did-user' },
        dids,
        mainDidId: 'did-main'
      })
    ).toBe('+49890002');
  });

  it('falls back to the company main number', () => {
    expect(
      presentedNumber({
        route: null,
        user: null,
        dids,
        mainDidId: 'did-main'
      })
    ).toBe('+49890003');
  });
});

describe('resolveClir', () => {
  it('the first non-null level wins', () => {
    expect(
      resolveClir({
        perCall: null,
        user: null,
        trunk: true,
        tenant: false,
        emergency: false
      })
    ).toBe(true);
  });

  it('falls back to the tenant default when every override is null', () => {
    expect(
      resolveClir({
        perCall: null,
        user: null,
        trunk: null,
        tenant: true,
        emergency: false
      })
    ).toBe(true);
  });

  it('is never withheld on an emergency call', () => {
    expect(
      resolveClir({
        perCall: true,
        user: true,
        trunk: true,
        tenant: true,
        emergency: true
      })
    ).toBe(false);
  });
});

describe('channelCapAllows', () => {
  it('allows any load when the cap is unlimited', () => {
    expect(channelCapAllows(1000, null)).toBe(true);
  });

  it('refuses a call once the cap is reached', () => {
    expect(channelCapAllows(5, 5)).toBe(false);
  });
});

describe('callerIdHeaders', () => {
  it('refuses a withheld call on a from-only trunk', () => {
    const result = callerIdHeaders({
      withhold: true,
      number: '+49891234',
      trunk: {
        callerIdHeader: 'from',
        callerIdFormat: 'e164'
      },
      country: 'DE'
    });

    expect(result).toEqual({ ok: false, code: 403 });
  });

  it('withholds over a both trunk, still presenting the real number for the PAI', () => {
    const result = callerIdHeaders({
      withhold: true,
      number: '+49891234',
      trunk: {
        callerIdHeader: 'both',
        callerIdFormat: 'e164'
      },
      country: 'DE'
    });

    expect(result).toEqual({ ok: true, number: '+49891234', withhold: true });
  });

  it("presents the number on a pai trunk too, whose From the endpoint's account identity replaces", () => {
    const result = callerIdHeaders({
      withhold: false,
      number: '+49891234',
      trunk: { callerIdHeader: 'pai', callerIdFormat: 'e164' },
      country: 'DE'
    });

    expect(result).toEqual({ ok: true, number: '+49891234', withhold: false });
  });

  it('renders the national format by dropping the country calling code for a leading 0', () => {
    const result = callerIdHeaders({
      withhold: false,
      number: '+4989123',
      trunk: {
        callerIdHeader: 'from',
        callerIdFormat: 'national'
      },
      country: 'DE'
    });

    expect(result).toEqual({ ok: true, number: '089123', withhold: false });
  });
});

it('ATTEMPT_NO_RESPONSE_MS matches the 8-second Route fallthrough budget', () => {
  expect(ATTEMPT_NO_RESPONSE_MS).toBe(8000);
});
