import { describe, expect, it } from 'vitest';

import { readEnv } from './env.js';

const REQUIRED = { ARI_PASSWORD: 'ari', AMI_PASSWORD: 'ami' };

// §6.1, §9.1: the address the stack writes into SIP, the host a forwarded leg's `Diversion`
// entries name (§9.4 "Forwarded calls").
describe('readEnv sipHost', () => {
  it('takes EXTERNAL_IPV4 in the ports mode, before STACK_IPV4', () => {
    expect(
      readEnv({
        ...REQUIRED,
        EXTERNAL_IPV4: '198.51.100.7',
        STACK_IPV4: '203.0.113.34'
      }).sipHost
    ).toBe('198.51.100.7');
  });

  it('takes STACK_IPV4 in the macvlan mode, an empty EXTERNAL_IPV4 counting as unset', () => {
    expect(
      readEnv({ ...REQUIRED, EXTERNAL_IPV4: '', STACK_IPV4: '203.0.113.34' })
        .sipHost
    ).toBe('203.0.113.34');
  });

  it('is null while neither is set', () => {
    expect(readEnv({ ...REQUIRED, STACK_IPV4: '' }).sipHost).toBeNull();
  });
});

// §6.3 "Environment": Compose hands an unset `${VAR:-}` over as the empty string.
describe('readEnv defaults', () => {
  it('takes the default for an unset or empty variable', () => {
    const env = readEnv({
      ...REQUIRED,
      TZ: '',
      DB_FILE: '',
      CALL_LOG_MAX_BYTES: ''
    });
    expect(env).toMatchObject({
      ariUrl: 'http://asterisk:8088/ari',
      amiHost: 'asterisk',
      amiPort: 5038,
      dbFile: '/data/zamfono.sqlite3',
      mediaDir: '/media',
      hepEnabled: true,
      callLogMaxBytes: 1048576,
      tz: 'UTC',
      timeZoneError: undefined,
      apiInternalUrl: 'http://api:3000'
    });
  });

  it('refuses an empty secret', () => {
    expect(() => readEnv({ ...REQUIRED, ARI_PASSWORD: '' })).toThrow(
      'missing required environment variable ARI_PASSWORD'
    );
  });

  it('names a TZ that is no IANA time zone, and the version', () => {
    const env = readEnv({
      ...REQUIRED,
      TZ: 'CET-1CEST',
      ZAMFONO_VERSION: '0.2.0',
      ZAMFONO_REVISION: 'a04ac57deadbeef'
    });
    expect(env.timeZoneError).toContain('TZ=CET-1CEST');
    expect(env.version.display).toBe('0.2.0 (a04ac57)');
  });
});
