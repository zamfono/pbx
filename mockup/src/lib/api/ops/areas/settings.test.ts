import { beforeEach, describe, expect, it } from 'vitest';

import '#lib/api/ops/index.js';

import { ApiError } from '#lib/api/errors.js';
import { call, type Actor } from '#lib/api/ops/core.js';
import { U } from '#lib/api/seed/ids.js';
import { resetDb, store } from '#lib/api/store.svelte.js';
import type { Settings } from '#lib/api/types.js';

const lea: Actor = { id: U.lea, name: 'Lea Brandt', role: 'owner' };
const jonas: Actor = { id: U.jonas, name: 'Jonas Weber', role: 'admin' };
const mira: Actor = { id: U.mira, name: 'Mira Kovač', role: 'user' };

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

describe('settings.get', () => {
  it('reads secrets only as *Set and is admin-only', () => {
    const settings = run<Settings>(jonas, 'settings.get', {});
    expect(settings.smtpPasswordSet).toBe(true);
    expect('smtpPassword' in settings).toBe(false);
    expect(refusal(() => run(mira, 'settings.get', {})).code).toBe(
      'forbiddenRole'
    );
  });
});

describe('settings.update gates', () => {
  it('refuses an owner-only field from an admin, accepts it from the owner', () => {
    expect(
      refusal(() =>
        run(jonas, 'settings.update', { smtpHost: 'mail.example.com' })
      ).code
    ).toBe('forbiddenOwnerOnly');
    expect(
      refusal(() =>
        run(jonas, 'settings.update', {
          companyName: 'X',
          auditRetentionDays: 400
        })
      ).code
    ).toBe('forbiddenOwnerOnly');
    run(lea, 'settings.update', { smtpHost: 'mail.example.com' });
    expect(store.db.settings.smtpHost).toBe('mail.example.com');
  });

  it('lets an admin change admin fields', () => {
    run(jonas, 'settings.update', { companyName: 'Brandt & Partner mbB' });
    expect(store.db.settings.companyName).toBe('Brandt & Partner mbB');
    expect(store.db.audit[0]?.operation).toBe('settings.update');
    expect(store.db.audit[0]?.undoable).toBe(true);
  });

  it('refuses read-only fields', () => {
    expect(
      refusal(() => run(lea, 'settings.update', { extLength: 4 })).code
    ).toBe('settingsReadOnly');
  });
});

describe('settings.update validation', () => {
  it('feature codes: ten keys, * or #, no prefix of another', () => {
    const codes = { ...store.db.settings.featureCodes };
    expect(
      refusal(() =>
        run(jonas, 'settings.update', { featureCodes: { pickup: '*8' } })
      ).code
    ).toBe('featureCodeKeys');
    expect(
      refusal(() =>
        run(jonas, 'settings.update', {
          featureCodes: { ...codes, park: '70' }
        })
      ).code
    ).toBe('featureCodeStart');
    const prefix = refusal(() =>
      run(jonas, 'settings.update', { featureCodes: { ...codes, park: '*80' } })
    );
    expect(prefix.code).toBe('featureCodePrefix');
    expect(prefix.field).toBe('featureCodes.park');
    run(jonas, 'settings.update', { featureCodes: { ...codes, park: '*71' } });
    expect(store.db.settings.featureCodes.park).toBe('*71');
  });

  it('emergency numbers: digits, never a live extension', () => {
    expect(
      refusal(() => run(lea, 'settings.update', { emergencyNumbers: [] })).code
    ).toBe('settingsEmergencyDigits');
    expect(
      refusal(() =>
        run(lea, 'settings.update', { emergencyNumbers: ['112', '101'] })
      ).code
    ).toBe('settingsEmergencyExtension');
    run(lea, 'settings.update', { emergencyNumbers: ['999', '116117'] });
    expect(store.db.settings.emergencyNumbers).toEqual(['999', '116117']);
  });

  it('SIP ban steps: increasing, permanent only last, [] switches off', () => {
    expect(
      refusal(() => run(jonas, 'settings.update', { sipBanSteps: [3600, 60] }))
        .code
    ).toBe('sipBanStepsIncreasing');
    expect(
      refusal(() =>
        run(jonas, 'settings.update', { sipBanSteps: [null, 3600] })
      ).code
    ).toBe('sipBanStepsPermanentLast');
    expect(
      refusal(() => run(jonas, 'settings.update', { sipBanSteps: [30] })).code
    ).toBe('sipBanStepsRange');
    run(jonas, 'settings.update', { sipBanSteps: [] });
    expect(store.db.settings.sipBanSteps).toEqual([]);
  });

  it('soft-delete retention must not exceed audit retention', () => {
    const error = refusal(() =>
      run(jonas, 'settings.update', { softDeleteRetentionDays: 900 })
    );
    expect(error.code).toBe('settingsRetentionWindow');
    expect(
      refusal(() =>
        run(jonas, 'settings.update', { softDeleteRetentionDays: null })
      ).code
    ).toBe('settingsRetentionWindow');
    run(lea, 'settings.update', {
      auditRetentionDays: null,
      softDeleteRetentionDays: null
    });
    expect(store.db.settings.softDeleteRetentionDays).toBeNull();
  });

  it('SSO rules per provider', () => {
    expect(
      refusal(() => run(lea, 'settings.update', { ssoTenantId: null })).code
    ).toBe('settingsSsoTenantId');
    expect(
      refusal(() =>
        run(lea, 'settings.update', { ssoProvider: 'oidc', ssoIssuer: null })
      ).code
    ).toBe('settingsSsoOidc');
    expect(
      refusal(() => run(lea, 'settings.update', { ssoClientId: null })).code
    ).toBe('settingsSsoClientId');
    run(lea, 'settings.update', { ssoProvider: null });
    expect(store.db.settings.ssoProvider).toBeNull();
  });

  it('backup cron and main number', () => {
    expect(
      refusal(() =>
        run(jonas, 'settings.update', { backupCron: 'every night' })
      ).code
    ).toBe('settingsCron');
    expect(
      refusal(() => run(jonas, 'settings.update', { mainDidId: 'nope' })).code
    ).toBe('settingsMainDid');
    run(jonas, 'settings.update', { backupCron: '30 2 * * 1-5' });
    expect(store.db.settings.backupCron).toBe('30 2 * * 1-5');
  });
});

describe('settings.update secrets and SSO bindings', () => {
  it('masks a secret change and makes it not undoable', () => {
    run(lea, 'settings.update', { smtpPassword: 'hunter2' });
    const entry = store.db.audit[0];
    expect(entry?.changes).toEqual([
      { field: 'smtpPassword', from: '•••', to: '•••' }
    ]);
    expect(entry?.undoable).toBe(false);
    run(lea, 'settings.update', { smtpPassword: null });
    expect(store.db.settings.smtpPasswordSet).toBe(false);
  });

  it('clears SSO bindings when the issuer changes, and undo restores them', () => {
    const bound = store.db.users.filter(user => user.ssoBound).length;
    run(lea, 'settings.update', {
      ssoIssuer: 'https://login.example.com/v2.0'
    });
    expect(store.db.users.filter(user => user.ssoBound)).toHaveLength(0);
    const entry = store.db.audit[0];
    if (bound > 0) {
      expect(
        entry?.changes.some(change => change.field === 'ssoSubjects')
      ).toBe(true);
    }
    run(lea, 'audit.undo', { id: entry?.id });
    expect(store.db.users.filter(user => user.ssoBound)).toHaveLength(bound);
    expect(store.db.settings.ssoIssuer).toContain('microsoftonline');
  });
});
