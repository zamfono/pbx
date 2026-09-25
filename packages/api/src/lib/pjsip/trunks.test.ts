import { describe, expect, test } from 'vitest';

import { render, type RenderInput } from './render.js';
import type { Trunk } from './shared.js';

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
      password: 'pass\\word',
      outboundProxy: 'sip:sbc.provider-a.example'
    });
    expect(conf).toContain('username = trunkuser');
    expect(conf).toContain('password = pass\\word');
    expect(conf).toContain('outbound_proxy = sip:sbc.provider-a.example\n');
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
