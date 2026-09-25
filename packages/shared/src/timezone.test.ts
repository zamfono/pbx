import { describe, expect, it } from 'vitest';

import { isIanaTimeZone, resolveTenantTimeZone } from './timezone.js';

describe('isIanaTimeZone', () => {
  it.each(['Europe/Berlin', 'America/New_York', 'UTC', 'Etc/UTC'])(
    'accepts %s',
    name => {
      expect(isIanaTimeZone(name)).toBe(true);
    }
  );

  it.each(['Mars/Olympus', 'Europe/Nowhere', '', '+01:00', '-05:00'])(
    'refuses %j',
    name => {
      expect(isIanaTimeZone(name)).toBe(false);
    }
  );
});

describe('resolveTenantTimeZone', () => {
  it('prefers settings.timezone', () => {
    expect(resolveTenantTimeZone('Europe/Berlin', 'America/New_York')).toBe(
      'Europe/Berlin'
    );
  });

  it('falls back to the stack TZ while settings.timezone is NULL (§11.4)', () => {
    expect(resolveTenantTimeZone(null, 'America/New_York')).toBe(
      'America/New_York'
    );
  });

  it('falls back to UTC without either', () => {
    expect(resolveTenantTimeZone(null, undefined)).toBe('UTC');
  });

  it('skips a stored zone Intl cannot use instead of throwing', () => {
    expect(resolveTenantTimeZone('Mars/Olympus', 'Europe/Vienna')).toBe(
      'Europe/Vienna'
    );
    expect(resolveTenantTimeZone('Mars/Olympus', 'CET-1CEST')).toBe('UTC');
  });
});
