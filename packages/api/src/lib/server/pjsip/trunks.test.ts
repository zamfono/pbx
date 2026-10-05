import { describe, expect, test } from 'vitest';

import { render } from './render.js';
import type { RenderInput, Trunk } from './shared.js';

/**
 * The value Asterisk's config parser (main/config.c) reads from `<key> = <value>` in `conf`:
 * the line is cut at the first `;` not preceded by a backslash, an escaped `\;` loses its
 * backslash, and the value is trimmed.
 */
function parsedValues(conf: string, key: string): string[] {
  return conf
    .split('\n')
    .filter(line => line.startsWith(`${key} = `))
    .map(line => {
      let value = line.slice(key.length + 3);
      let from = 0;
      for (;;) {
        const index = value.indexOf(';', from);
        if (index === -1) {
          break;
        }
        if (index > from && value[index - 1] === '\\') {
          value = value.slice(0, index - 1) + value.slice(index);
          from = index;
        } else {
          value = value.slice(0, index);
          break;
        }
      }
      return value.trim();
    });
}

const registrationTrunk: Trunk = {
  id: 't1',
  name: 'Trunk A',
  authMode: 'registration',
  username: 'acct;4711',
  password: 'ab;cd\\;ef',
  inboundAuth: false,
  transport: 'udp',
  srtp: false,
  tlsVerify: true,
  qualify: true,
  outboundProxy: 'sip:sbc.provider-a.example;lr;transport=udp',
  registerExpiryS: null,
  registerRetryS: null,
  callerIdHeader: 'from',
  codecs: null,
  hosts: [
    {
      priority: 1,
      host: 'sip.provider-a.example',
      port: null,
      direction: 'both'
    }
  ]
};

function renderTrunk(trunk: Trunk): string {
  const input: RenderInput = {
    settings: {
      codecs: ['alaw'],
      ringotelMaxRegs: 3,
      extLength: 3,
      holdMohClass: 'default'
    },
    users: [],
    devices: [],
    ringGroups: [],
    parkingSlots: [],
    trunks: [trunk],
    moh: []
  };
  return render(input)['pjsip_trunks.conf'];
}

describe('renderTrunksConf escaping', () => {
  test('a password with a semicolon reaches Asterisk whole', () => {
    const conf = renderTrunk(registrationTrunk);
    expect(conf).toContain('password = ab\\;cd\\\\;ef');
    expect(parsedValues(conf, 'password')).toEqual(['ab;cd\\;ef']);
  });

  test('a username with a semicolon reaches Asterisk whole, in auth and in client_uri', () => {
    const conf = renderTrunk(registrationTrunk);
    expect(parsedValues(conf, 'username')).toEqual(['acct;4711']);
    expect(parsedValues(conf, 'client_uri')).toEqual([
      'sip:acct;4711@sip.provider-a.example'
    ]);
    expect(parsedValues(conf, 'contact_user')).toEqual(['acct;4711']);
  });

  test('outbound proxy URI parameters survive into every outbound_proxy line', () => {
    const conf = renderTrunk(registrationTrunk);
    expect(parsedValues(conf, 'outbound_proxy')).toEqual([
      'sip:sbc.provider-a.example;lr;transport=udp',
      'sip:sbc.provider-a.example;lr;transport=udp',
      'sip:sbc.provider-a.example;lr;transport=udp'
    ]);
  });

  test('values without a semicolon are written unchanged', () => {
    const conf = renderTrunk({
      ...registrationTrunk,
      username: 'trunkuser',
      password: 'pass\\word'
    });
    expect(conf).toContain('username = trunkuser');
    expect(conf).toContain('password = pass\\word');
  });

  test('an outbound proxy without `;lr` is written loose-routing, in every outbound_proxy line', () => {
    const conf = renderTrunk({
      ...registrationTrunk,
      outboundProxy: 'sips:sbc.provider-a.example:5061;transport=tls'
    });
    expect(parsedValues(conf, 'outbound_proxy')).toEqual([
      'sips:sbc.provider-a.example:5061;transport=tls;lr',
      'sips:sbc.provider-a.example:5061;transport=tls;lr',
      'sips:sbc.provider-a.example:5061;transport=tls;lr'
    ]);
  });
});

describe('renderTrunksConf registration retries', () => {
  test('every failure, a 403 or a rejected challenge included, retries at register_retry_s, indefinitely', () => {
    const conf = renderTrunk({ ...registrationTrunk, registerRetryS: 45 });
    expect(parsedValues(conf, 'retry_interval')).toEqual(['45']);
    expect(parsedValues(conf, 'forbidden_retry_interval')).toEqual(['45']);
    expect(parsedValues(conf, 'fatal_retry_interval')).toEqual(['45']);
    expect(parsedValues(conf, 'max_retries')).toEqual(['4294967295']);
    expect(parsedValues(conf, 'auth_rejection_permanent')).toEqual(['no']);
  });

  test("a trunk without register_retry_s retries at Asterisk's own 60 s", () => {
    const conf = renderTrunk(registrationTrunk);
    expect(parsedValues(conf, 'retry_interval')).toEqual([]);
    expect(parsedValues(conf, 'forbidden_retry_interval')).toEqual(['60']);
    expect(parsedValues(conf, 'fatal_retry_interval')).toEqual(['60']);
  });

  test('an ip trunk registers nothing, so it carries no retry policy', () => {
    const conf = renderTrunk({ ...registrationTrunk, authMode: 'ip' });
    expect(parsedValues(conf, 'max_retries')).toEqual([]);
  });
});

describe('renderTrunksConf connected line and redirecting', () => {
  // §9.4 "Caller-ID", "Anonymous calls (CLIR)": the provider is told the presented number by the
  // call's own INVITE, never the bridged party's identity by a later connected-line update; and
  // "Forwarded calls": no `Diversion` or `History-Info` of chan_pjsip's, the core writes its own.
  test('neither endpoint of a trunk sends connected-line updates or Diversion, whatever its header layout', () => {
    for (const callerIdHeader of ['from', 'pai', 'both'] as const) {
      const conf = renderTrunk({
        ...registrationTrunk,
        username: 'trunkuser',
        inboundAuth: true,
        callerIdHeader
      });
      const endpoints = conf
        .split('\n\n')
        .filter(block => block.split('\n').includes('type = endpoint'));
      expect(endpoints.map(block => block.split('\n')[0])).toEqual([
        '[trunk-t1]',
        '[trunkuser]'
      ]);
      for (const endpoint of endpoints) {
        expect(parsedValues(endpoint, 'send_connected_line')).toEqual(['no']);
        expect(parsedValues(endpoint, 'send_diversion')).toEqual(['no']);
        expect(parsedValues(endpoint, 'send_history_info')).toEqual([]);
      }
    }
  });
});

describe('renderTrunksConf TLS and SRTP', () => {
  const tlsTrunk: Trunk = {
    ...registrationTrunk,
    username: 'trunkuser',
    password: 'pass',
    outboundProxy: null,
    transport: 'tls'
  };

  // §9.1, §9.4 "Signaling": PJSIP checks a server certificate per transport, so the trunk's
  // `tls_verify` picks the TLS transport its endpoint and registration name.
  test('a tls trunk that checks its certificate uses transport-tls, one that does not transport-tls-noverify', () => {
    expect(
      parsedValues(renderTrunk({ ...tlsTrunk, tlsVerify: true }), 'transport')
    ).toEqual(['transport-tls', 'transport-tls']);
    expect(
      parsedValues(renderTrunk({ ...tlsTrunk, tlsVerify: false }), 'transport')
    ).toEqual(['transport-tls-noverify', 'transport-tls-noverify']);
  });

  test('tls_verify is ignored on a trunk that does not use tls', () => {
    const conf = renderTrunk({ ...registrationTrunk, tlsVerify: false });
    expect(parsedValues(conf, 'transport')).toEqual([
      'transport-udp',
      'transport-udp'
    ]);
  });

  test('an srtp trunk encrypts its media on both of its endpoints; without srtp neither does', () => {
    const withAuthEndpoint: Trunk = { ...tlsTrunk, inboundAuth: true };
    const conf = renderTrunk({ ...withAuthEndpoint, srtp: true });
    const endpoints = conf
      .split('\n\n')
      .filter(block => block.split('\n').includes('type = endpoint'));
    expect(endpoints).toHaveLength(2);
    for (const endpoint of endpoints) {
      expect(parsedValues(endpoint, 'media_encryption')).toEqual(['sdes']);
    }
    expect(
      parsedValues(renderTrunk(withAuthEndpoint), 'media_encryption')
    ).toEqual([]);
  });
});

// §9.4 "Provisioning and status": `qualify` switches an `ip` trunk's OPTIONS probe; a
// `registration` trunk's status is its registration's, so it is never probed either way.
describe('renderTrunksConf qualify', () => {
  const ipTrunk: Trunk = {
    ...registrationTrunk,
    authMode: 'ip',
    username: null,
    password: null,
    outboundProxy: null
  };

  test('an ip trunk is probed every 60 s with qualify on and never with it off', () => {
    expect(
      parsedValues(
        renderTrunk({ ...ipTrunk, qualify: true }),
        'qualify_frequency'
      )
    ).toEqual(['60']);
    expect(
      parsedValues(
        renderTrunk({ ...ipTrunk, qualify: false }),
        'qualify_frequency'
      )
    ).toEqual(['0']);
  });

  test('qualify is ignored on a registration trunk', () => {
    for (const qualify of [true, false]) {
      expect(
        parsedValues(
          renderTrunk({ ...registrationTrunk, qualify }),
          'qualify_frequency'
        )
      ).toEqual([]);
    }
  });
});
