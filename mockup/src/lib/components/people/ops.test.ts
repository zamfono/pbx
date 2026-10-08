import { beforeEach, describe, expect, it } from 'vitest';

import '#lib/api/ops/index.js';

import { ApiError } from '#lib/api/errors.js';
import { call, type Actor, type CallOptions } from '#lib/api/ops/core.js';
import { DID, RG, U, UG } from '#lib/api/seed/ids.js';
import { resetDb, store } from '#lib/api/store.svelte.js';
import type { User, UserGroup } from '#lib/api/types.js';

const lea: Actor = { id: U.lea, name: 'Lea Brandt', role: 'owner' };
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

const user = (id: string): User =>
  store.db.users.find(candidate => candidate.id === id) as User;

beforeEach(() => {
  resetDb();
});

describe('users.create', () => {
  it('gives a set-password link to a user with an e-mail, none to a phone-only one', () => {
    const withMail = call<{ user: User; setupLink: string | null }>(
      'users.create',
      { name: 'Anna', email: 'anna@example.com', extension: '115' },
      as(jonas)
    );
    expect(withMail.setupLink).toMatch(
      /^https:\/\/tel\.brandt-partner\.de\/auth\/setPassword\?token=/u
    );
    const phoneOnly = call<{ setupLink: string | null }>(
      'users.create',
      { name: 'Lager', extension: '116' },
      as(jonas)
    );
    expect(phoneOnly.setupLink).toBeNull();
  });

  it('lets only an owner give a role other than user', () => {
    expect(
      refusal(() =>
        call(
          'users.create',
          { name: 'X', email: 'x@example.com', role: 'admin' },
          as(jonas)
        )
      ).code
    ).toBe('forbiddenOwnerOnly');
    expect(() =>
      call(
        'users.create',
        { name: 'X', email: 'x@example.com', role: 'admin' },
        as(lea)
      )
    ).not.toThrow();
  });

  it('needs an e-mail or an extension, and an e-mail for an admin', () => {
    expect(
      refusal(() => call('users.create', { name: 'X' }, as(lea))).code
    ).toBe('people.needsContact');
    expect(
      refusal(() =>
        call(
          'users.create',
          { name: 'X', extension: '117', role: 'admin' },
          as(lea)
        )
      ).code
    ).toBe('people.roleNeedsEmail');
  });

  it('refuses a taken extension and a taken e-mail', () => {
    expect(
      refusal(() =>
        call('users.create', { name: 'X', extension: '101' }, as(jonas))
      ).code
    ).toBe('extensionTaken');
    expect(
      refusal(() =>
        call(
          'users.create',
          { name: 'X', email: 'lea.brandt@brandt-partner.de' },
          as(jonas)
        )
      ).code
    ).toBe('people.emailTaken');
  });
});

describe('users.update', () => {
  it('lets a user change their own self-service fields only', () => {
    call(
      'users.update',
      { id: U.mira, ringTimeoutS: 40, clir: true },
      as(mira)
    );
    expect(user(U.mira).ringTimeoutS).toBe(40);
    expect(
      refusal(() =>
        call('users.update', { id: U.mira, name: 'Mira K.' }, as(mira))
      ).code
    ).toBe('people.adminOnlyField');
    expect(
      refusal(() =>
        call('users.update', { id: U.jonas, ringTimeoutS: 40 }, as(mira))
      ).code
    ).toBe('forbiddenNotOwn');
  });

  it("keeps roles and an owner's e-mail to owners", () => {
    expect(
      refusal(() =>
        call('users.update', { id: U.mira, role: 'admin' }, as(jonas))
      ).code
    ).toBe('people.onlyOwnersChangeRoles');
    expect(
      refusal(() =>
        call('users.update', { id: U.lea, email: 'lea@example.com' }, as(jonas))
      ).code
    ).toBe('people.ownerEmailOwnerOnly');
  });

  it('never demotes the last owner who can log in', () => {
    call('users.update', { id: U.felix, role: 'admin' }, as(lea));
    expect(
      refusal(() => call('users.update', { id: U.lea, role: 'admin' }, as(lea)))
        .code
    ).toBe('people.lastOwner');
  });

  it('refuses one of the tenant’s own numbers as a find-me leg', () => {
    expect(
      refusal(() =>
        call(
          'users.update',
          { id: U.mira, findMe: [{ number: '+49894520101', delayS: 0 }] },
          as(mira)
        )
      ).code
    ).toBe('people.findMeOwnDid');
  });

  it('renames devices and BLF keys with the extension', () => {
    const result = call<{ affectedDevices?: { sipUsername: string }[] }>(
      'users.update',
      { id: U.felix, extension: '130' },
      as(lea)
    );
    expect(result.affectedDevices?.[0]?.sipUsername).toMatch(/^e130-/u);
    expect(store.db.blf.some(entry => entry.keys.includes('104'))).toBe(false);
    expect(store.db.blf.some(entry => entry.keys.includes('130'))).toBe(true);
  });
});

describe('users.delete', () => {
  it('is owner-only for an owner and refused while something points at the user', () => {
    expect(
      refusal(() => call('users.delete', { id: U.felix }, as(jonas))).code
    ).toBe('forbiddenOwnerOnly');
    const inUse = refusal(() =>
      call('users.delete', { id: U.mira }, as(jonas))
    );
    expect(inUse.code).toBe('inUse');
    expect(
      inUse.refs.some(ref => ref.kind === 'did' && ref.id === DID.mira)
    ).toBe(true);
  });

  it('asks first, then cascades the devices', () => {
    expect(
      refusal(() => call('users.delete', { id: U.katrin }, as(jonas, false)))
        .code
    ).toBe('confirmationRequired');
    call('users.delete', { id: U.katrin }, as(jonas));
    expect(
      store.db.devices.filter(
        device => device.userId === U.katrin && device.deletedAt === null
      )
    ).toHaveLength(0);
  });
});

describe('users.setForwarding', () => {
  it('refuses a new sip or recording target for a user but keeps one an admin set', () => {
    const recording = {
      kind: 'external' as const,
      external: '+491715550199',
      record: true
    };
    expect(
      refusal(() =>
        call(
          'users.setForwarding',
          { id: U.mira, rules: [{ condition: 'busy', target: recording }] },
          as(mira)
        )
      ).code
    ).toBe('people.recordTargetAdminOnly');
    call(
      'users.setForwarding',
      { id: U.mira, rules: [{ condition: 'busy', target: recording }] },
      as(jonas)
    );
    call(
      'users.setForwarding',
      {
        id: U.mira,
        rules: [
          { condition: 'busy', target: recording },
          {
            condition: 'noAnswer',
            target: { kind: 'mailboxUser', userId: U.mira }
          }
        ]
      },
      as(mira)
    );
    expect(store.db.userForwarding[U.mira]).toHaveLength(2);
  });

  it('allows one rule per condition', () => {
    const target = { kind: 'mailboxUser' as const, userId: U.mira };
    expect(
      refusal(() =>
        call(
          'users.setForwarding',
          {
            id: U.mira,
            rules: [
              { condition: 'busy', target },
              { condition: 'busy', target }
            ]
          },
          as(mira)
        )
      ).code
    ).toBe('people.duplicateCondition');
  });
});

describe('devices', () => {
  it('lets a user add their own tls device only, and only one ringotel app', () => {
    const created = call<{ connectionSettings?: { port: number } }>(
      'devices.create',
      { userId: U.mira, label: 'Softphone', kind: 'manual' },
      as(mira)
    );
    expect(created.connectionSettings?.port).toBe(5061);
    expect(
      refusal(() =>
        call(
          'devices.create',
          {
            userId: U.mira,
            label: 'Lab',
            kind: 'manual',
            transport: 'plain',
            allowedIps: ['10.0.0.1']
          },
          as(mira)
        )
      ).code
    ).toBe('forbiddenNotOwn');
    expect(
      refusal(() =>
        call(
          'devices.create',
          { userId: U.mira, label: 'App 2', kind: 'ringotel' },
          as(mira)
        )
      ).code
    ).toBe('people.oneRingotel');
  });

  it('requires allowed IPs for a plain device', () => {
    expect(
      refusal(() =>
        call(
          'devices.create',
          {
            userId: U.sophie,
            label: 'Lab',
            kind: 'manual',
            transport: 'plain'
          },
          as(jonas)
        )
      ).code
    ).toBe('people.plainNeedsIps');
  });

  it('keeps reveal and rotate to admins', () => {
    const device = store.db.devices.find(
      candidate => candidate.userId === U.mira
    ) as { id: string };
    expect(
      refusal(() =>
        call('devices.revealCredentials', { id: device.id }, as(mira))
      ).code
    ).toBe('forbiddenRole');
    expect(
      call<{ sipPassword: string }>(
        'devices.revealCredentials',
        { id: device.id },
        as(jonas)
      ).sipPassword
    ).toBeTruthy();
  });
});

describe('personalAccessTokens', () => {
  it('returns the value once, refuses a taken name and keeps owners’ tokens to owners', () => {
    const token = call<{ token: string }>(
      'personalAccessTokens.create',
      { userId: U.mira, name: 'crm' },
      as(mira)
    );
    expect(token.token).toMatch(/^zpat_/u);
    expect(
      refusal(() =>
        call(
          'personalAccessTokens.create',
          { userId: U.mira, name: 'crm' },
          as(mira)
        )
      ).code
    ).toBe('people.tokenNameTaken');
    expect(
      refusal(() =>
        call('personalAccessTokens.list', { userId: U.lea }, as(jonas))
      ).code
    ).toBe('forbiddenOwnerOnly');
  });
});

describe('userGroups', () => {
  it('refuses a nesting that would contain itself', () => {
    const group = store.db.userGroups.find(
      candidate => candidate.id === UG.beratung
    ) as UserGroup;
    const cycle = refusal(() =>
      call(
        'userGroups.update',
        {
          id: group.id,
          members: [...group.members, { kind: 'userGroup', id: UG.alle }]
        },
        as(jonas)
      )
    );
    expect(cycle.code).toBe('people.groupCycle');
  });

  it('deletes a group still named by a ring group', () => {
    expect(
      store.db.ringGroups
        .find(group => group.id === RG.beratung)
        ?.members.some(member => member.id === UG.beratung)
    ).toBe(true);
    call('userGroups.delete', { id: UG.beratung }, as(jonas));
    expect(
      store.db.userGroups.find(group => group.id === UG.beratung)?.deletedAt
    ).not.toBeNull();
  });
});
