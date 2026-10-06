import { describe, expect, it } from 'vitest';

import { readEnv } from './env.js';

// The secrets, and the public address of the ports mode (§6.1), a documentation-range address.
const REQUIRED = {
  ARI_PASSWORD: 'ari',
  AMI_PASSWORD: 'ami',
  EXTERNAL_IPV4: '192.0.2.10',
  FQDN: 'pbx.example.com'
};

// §9.4 "Caller-ID": the From host of a trunk leg not on a `pai` trunk, and the host its
// `Diversion` entries name ("Forwarded calls").
describe('readEnv fqdn', () => {
  it('takes FQDN in lower case', () => {
    expect(readEnv({ ...REQUIRED, FQDN: 'PBX.Example.com' }).fqdn).toBe(
      'pbx.example.com'
    );
  });

  it('refuses to start without FQDN', () => {
    expect(() => readEnv({ ...REQUIRED, FQDN: '' })).toThrow(
      'missing required environment variable FQDN'
    );
  });
});

// §6.3 "Environment": the mode's overlay requires one of them (§6.1).
describe('readEnv public address', () => {
  it('refuses to start while neither EXTERNAL_IPV4 nor STACK_IPV4 is set', () => {
    expect(() =>
      readEnv({ ...REQUIRED, EXTERNAL_IPV4: '', STACK_IPV4: '' })
    ).toThrow(
      'missing required environment variable EXTERNAL_IPV4 or STACK_IPV4'
    );
  });
});

// §6.3 "Environment": Compose hands an unset `${VAR:-}` over as the empty string.
describe('readEnv defaults', () => {
  it('takes the default for an unset or empty variable', () => {
    const env = readEnv({
      ...REQUIRED,
      TZ: '',
      DB_FILE: '',
      SIP_UDP_ENABLED: '',
      SIP_TCP_ENABLED: '',
      CALL_LOG_MAX_BYTES: ''
    });
    expect(env).toMatchObject({
      ariUrl: 'http://asterisk:8088/ari',
      amiHost: 'asterisk',
      amiPort: 5038,
      dbFile: '/data/zamfono.sqlite3',
      mediaDir: '/media',
      hepEnabled: true,
      sipUdpEnabled: true,
      sipTcpEnabled: true,
      callLogMaxBytes: 1048576,
      tz: 'UTC',
      timeZoneError: undefined,
      apiInternalUrl: 'http://api:3000'
    });
  });

  it('reads SIP_UDP_ENABLED and SIP_TCP_ENABLED as on unless false (§9.1)', () => {
    expect(
      readEnv({ ...REQUIRED, SIP_UDP_ENABLED: 'false', SIP_TCP_ENABLED: 'yes' })
    ).toMatchObject({ sipUdpEnabled: false, sipTcpEnabled: true });
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
