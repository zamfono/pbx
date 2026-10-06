import { describe, expect, test } from 'vitest';

import { configValues, parseAsteriskConfig } from '#testing/asteriskConfig.js';

import { render } from './render.js';
import type { RenderInput, Trunk } from './shared.js';

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

// The registrar alone, a host that is dialled but never a source address (§9.4 "Hosts").
const registrarOnly: Pick<Trunk, 'hosts'> = {
  hosts: registrationTrunk.hosts.map(host => ({
    ...host,
    direction: 'outbound'
  }))
};

function renderTrunk(trunk: Trunk): string {
  const input: RenderInput = {
    fqdn: 'pbx.example.com',
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
  return render(input).files['pjsip_trunks.conf'];
}

describe('renderTrunksConf escaping', () => {
  test('a password with a semicolon reaches Asterisk whole', () => {
    const conf = renderTrunk(registrationTrunk);
    expect(conf).toContain('password = ab\\;cd\\\\;ef');
    expect(configValues(conf, 'password')).toEqual(['ab;cd\\;ef']);
  });

  test('a username with a semicolon reaches Asterisk whole, in auth and in client_uri', () => {
    const conf = renderTrunk(registrationTrunk);
    expect(configValues(conf, 'username')).toEqual(['acct;4711']);
    expect(configValues(conf, 'client_uri')).toEqual([
      'sip:acct;4711@sip.provider-a.example'
    ]);
    expect(configValues(conf, 'contact_user')).toEqual(['acct;4711']);
  });

  test('outbound proxy URI parameters survive into every outbound_proxy line', () => {
    const conf = renderTrunk(registrationTrunk);
    expect(configValues(conf, 'outbound_proxy')).toEqual([
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
    expect(configValues(conf, 'outbound_proxy')).toEqual([
      'sips:sbc.provider-a.example:5061;transport=tls;lr',
      'sips:sbc.provider-a.example:5061;transport=tls;lr',
      'sips:sbc.provider-a.example:5061;transport=tls;lr'
    ]);
  });

  // `[` opens a category only at the start of a line, `;` is escaped, a line splits at its
  // first `=`, and `>` counts only right after that `=`: none of them, at either end of the
  // value or inside it, changes what Asterisk reads.
  test.each(['[', ']', '[x]', ';', '=', '>', '=>', '\\', '\\;', '#', '"'])(
    'a password holding %s reads back whole, in the one auth section',
    special => {
      const password = `${special}pa${special}ss${special}`;
      const conf = renderTrunk({ ...registrationTrunk, password });
      expect(configValues(conf, 'password')).toEqual([password]);
      expect(
        parseAsteriskConfig(conf).filter(category =>
          category.variables.some(
            ([name, value]) => name === 'type' && value === 'auth'
          )
        )
      ).toHaveLength(1);
    }
  );
});

describe('renderTrunksConf username', () => {
  test('a username of every SIP URI user character class reads back whole, in auth and in client_uri', () => {
    const username = "a-b_c.d!e~f*g'h(i)j&k=l+m$n,o;p?q/r%40";
    const conf = renderTrunk({ ...registrationTrunk, username });
    expect(configValues(conf, 'username')).toEqual([username]);
    expect(configValues(conf, 'client_uri')).toEqual([
      `sip:${username}@sip.provider-a.example`
    ]);
  });

  test.each(['a<b', 'a"b', 'a#b', 'a:b', 'a%b', 'a b'])(
    'a stored username %j, no SIP URI user character, leaves its trunk out',
    username => {
      const { files, skipped } = render({
        fqdn: 'pbx.example.com',
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
        trunks: [
          { ...registrationTrunk, username },
          { ...registrationTrunk, id: 't2', name: 'Trunk B' }
        ],
        moh: []
      });
      expect(skipped).toEqual([
        { type: 'trunk', id: 't1', field: 'trunk.username' }
      ]);
      expect(files['pjsip_trunks.conf']).not.toContain('[trunk-t1]');
      expect(files['pjsip_trunks.conf']).toContain('[trunk-t2]');
    }
  );
});

describe('renderTrunksConf registration retries', () => {
  test('every failure, a 403 or a rejected challenge included, retries at register_retry_s, indefinitely', () => {
    const conf = renderTrunk({ ...registrationTrunk, registerRetryS: 45 });
    expect(configValues(conf, 'retry_interval')).toEqual(['45']);
    expect(configValues(conf, 'forbidden_retry_interval')).toEqual(['45']);
    expect(configValues(conf, 'fatal_retry_interval')).toEqual(['45']);
    expect(configValues(conf, 'max_retries')).toEqual(['4294967295']);
    expect(configValues(conf, 'auth_rejection_permanent')).toEqual(['no']);
  });

  test('a registration trunk without a registrar is left out, the other trunks rendered', () => {
    const { files, skipped } = render({
      fqdn: 'pbx.example.com',
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
      trunks: [
        {
          ...registrationTrunk,
          hosts: registrationTrunk.hosts.map(host => ({
            ...host,
            direction: 'inbound'
          }))
        },
        { ...registrationTrunk, id: 't2', name: 'Trunk B' }
      ],
      moh: []
    });
    expect(skipped).toEqual([
      { type: 'trunk', id: 't1', field: 'trunk.hosts' }
    ]);
    expect(files['pjsip_trunks.conf']).not.toContain('[trunk-t1]');
    expect(files['pjsip_trunks.conf']).toContain('[trunk-t2]');
  });

  test("a trunk without register_retry_s retries at Asterisk's own 60 s", () => {
    const conf = renderTrunk(registrationTrunk);
    expect(configValues(conf, 'retry_interval')).toEqual([]);
    expect(configValues(conf, 'forbidden_retry_interval')).toEqual(['60']);
    expect(configValues(conf, 'fatal_retry_interval')).toEqual(['60']);
  });

  test('an ip trunk registers nothing, so it carries no retry policy', () => {
    const conf = renderTrunk({ ...registrationTrunk, authMode: 'ip' });
    expect(configValues(conf, 'max_retries')).toEqual([]);
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
        ...registrarOnly,
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
        expect(configValues(endpoint, 'send_connected_line')).toEqual(['no']);
        expect(configValues(endpoint, 'send_diversion')).toEqual(['no']);
        expect(configValues(endpoint, 'send_history_info')).toEqual([]);
      }
    }
  });
});

// §5.6, §9.4 "Inbound identification": an `inbound_auth` trunk's credential identifies a call from
// anywhere only while no source host is listed; with one, the call must come from a listed host.
describe('renderTrunksConf inbound_auth source restriction', () => {
  const authTrunk: Trunk = {
    ...registrationTrunk,
    username: 'trunkuser',
    inboundAuth: true
  };
  const endpointNames = (trunk: Trunk): (string | undefined)[] =>
    renderTrunk(trunk)
      .split('\n\n')
      .filter(block => block.split('\n').includes('type = endpoint'))
      .map(block => block.split('\n')[0]);

  test('an 80-byte username, too long for a section name, leaves its trunk out', () => {
    const { files, skipped } = render({
      fqdn: 'pbx.example.com',
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
      trunks: [
        { ...authTrunk, ...registrarOnly, username: 'a'.repeat(80) },
        { ...authTrunk, ...registrarOnly, id: 't2', name: 'Trunk B' }
      ],
      moh: []
    });
    expect(skipped).toEqual([
      { type: 'trunk', id: 't1', field: 'trunk.username' }
    ]);
    expect(files['pjsip_trunks.conf']).not.toContain('[trunk-t1]');
    expect(files['pjsip_trunks.conf']).toContain('[trunkuser]');
  });

  test('a 79-byte username names its endpoint whole', () => {
    const username = 'a'.repeat(79);
    expect(endpointNames({ ...authTrunk, ...registrarOnly, username })).toEqual(
      ['[trunk-t1]', `[${username}]`]
    );
  });

  test('with an inbound or both host, only the host-identified endpoint takes the credential', () => {
    for (const direction of ['both', 'inbound'] as const) {
      const trunk: Trunk = {
        ...authTrunk,
        hosts: [
          ...registrarOnly.hosts,
          { priority: 2, host: '192.0.2.7', port: null, direction }
        ]
      };
      expect(endpointNames(trunk)).toEqual(['[trunk-t1]']);
      expect(renderTrunk(trunk)).toContain(
        'auth = trunk-t1\nidentify_by = ip\n'
      );
    }
  });

  test('without one, the endpoint named by the username takes it from any address', () => {
    expect(endpointNames({ ...authTrunk, hosts: registrarOnly.hosts })).toEqual(
      ['[trunk-t1]', '[trunkuser]']
    );
  });
});

// A caller on a provider without `telephone-event` reaches a menu (§10.1 "Target menu") with
// in-band DTMF.
describe('renderTrunksConf DTMF', () => {
  test('both endpoints of a trunk take RFC 4733 DTMF where offered and in-band DTMF otherwise', () => {
    const conf = renderTrunk({
      ...registrationTrunk,
      ...registrarOnly,
      username: 'trunkuser',
      inboundAuth: true
    });
    expect(configValues(conf, 'dtmf_mode')).toEqual(['auto', 'auto']);
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
      configValues(renderTrunk({ ...tlsTrunk, tlsVerify: true }), 'transport')
    ).toEqual(['transport-tls', 'transport-tls']);
    expect(
      configValues(renderTrunk({ ...tlsTrunk, tlsVerify: false }), 'transport')
    ).toEqual(['transport-tls-noverify', 'transport-tls-noverify']);
  });

  test('tls_verify is ignored on a trunk that does not use tls', () => {
    const conf = renderTrunk({ ...registrationTrunk, tlsVerify: false });
    expect(configValues(conf, 'transport')).toEqual([
      'transport-udp',
      'transport-udp'
    ]);
  });

  test('an srtp trunk encrypts its media on both of its endpoints; without srtp neither does', () => {
    const withAuthEndpoint: Trunk = {
      ...tlsTrunk,
      ...registrarOnly,
      inboundAuth: true
    };
    const conf = renderTrunk({ ...withAuthEndpoint, srtp: true });
    const endpoints = conf
      .split('\n\n')
      .filter(block => block.split('\n').includes('type = endpoint'));
    expect(endpoints).toHaveLength(2);
    for (const endpoint of endpoints) {
      expect(configValues(endpoint, 'media_encryption')).toEqual(['sdes']);
    }
    expect(
      configValues(renderTrunk(withAuthEndpoint), 'media_encryption')
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
      configValues(
        renderTrunk({ ...ipTrunk, qualify: true }),
        'qualify_frequency'
      )
    ).toEqual(['60']);
    expect(
      configValues(
        renderTrunk({ ...ipTrunk, qualify: false }),
        'qualify_frequency'
      )
    ).toEqual(['0']);
  });

  test('qualify is ignored on a registration trunk', () => {
    for (const qualify of [true, false]) {
      expect(
        configValues(
          renderTrunk({ ...registrationTrunk, qualify }),
          'qualify_frequency'
        )
      ).toEqual([]);
    }
  });
});
