import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

import { render } from './render.js';
import type { RenderInput } from './shared.js';

function fixture(name: string): string {
  const path = fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));
  return readFileSync(path, 'utf8');
}

// One manual `plain` device and one `ringotel` device on the same user, one `registration`
// trunk (`line=yes`, `support_outbound=yes`) and one `ip` trunk with a `both` and an
// `inbound` CIDR host plus `inbound_auth`, and one `ip` trunk over TLS with SRTP that does not
// check its provider's certificate (§9.3, §9.4).
const input: RenderInput = {
  settings: {
    codecs: ['opus', 'g722', 'alaw'],
    ringotelMaxRegs: 3,
    extLength: 3,
    holdMohClass: 'm2'
  },
  users: [{ id: 'u1', ext: '101', name: 'Anna Huber', ringGroupIds: ['rg1'] }],
  devices: [
    {
      id: 'd1',
      userId: 'u1',
      kind: 'manual',
      transport: 'plain',
      allowedIps: ['10.0.0.0/8'],
      sipUsername: 'e101-d3kx7',
      sipPassword: 'a1B2c3D4e5F6g7H8i9J0k1L2'
    },
    {
      id: 'd2',
      userId: 'u1',
      kind: 'ringotel',
      transport: 'tls',
      allowedIps: null,
      sipUsername: 'e101-dz9k2',
      sipPassword: 'z9Y8x7W6v5U4t3S2r1Q0p9O8'
    }
  ],
  ringGroups: [{ id: 'rg1', ext: '600' }],
  parkingSlots: ['701'],
  trunks: [
    {
      id: 't1',
      name: 'Trunk A',
      authMode: 'registration',
      username: 'trunkuser',
      password: 'trunkpass1234567890',
      inboundAuth: false,
      transport: 'udp',
      srtp: false,
      tlsVerify: true,
      qualify: true,
      outboundProxy: null,
      registerExpiryS: 3600,
      registerRetryS: 30,
      callerIdHeader: 'from',
      codecs: null,
      hosts: [
        // Lower priority number than the registrar, and `inbound`-only: must never become
        // the registration target even though it sorts first (§9.4 "Hosts").
        { priority: 1, host: '198.51.100.5', port: null, direction: 'inbound' },
        {
          priority: 2,
          host: 'sip.provider-a.example',
          port: null,
          direction: 'both'
        }
      ]
    },
    {
      id: 't2',
      name: 'Trunk B',
      authMode: 'ip',
      username: 'ipuser',
      password: 'ippass1234567890',
      inboundAuth: true,
      transport: 'tcp',
      srtp: false,
      tlsVerify: true,
      qualify: true,
      outboundProxy: null,
      registerExpiryS: null,
      registerRetryS: null,
      callerIdHeader: 'pai',
      codecs: ['ulaw'],
      hosts: [
        { priority: 1, host: '203.0.113.10', port: null, direction: 'both' },
        { priority: 2, host: '10.0.0.0/8', port: null, direction: 'inbound' }
      ]
    },
    {
      id: 't3',
      name: 'Trunk C',
      authMode: 'ip',
      username: null,
      password: null,
      inboundAuth: false,
      transport: 'tls',
      srtp: true,
      tlsVerify: false,
      // An endpoint that answers no OPTIONS (§9.4 "Provisioning and status").
      qualify: false,
      outboundProxy: null,
      registerExpiryS: null,
      registerRetryS: null,
      callerIdHeader: 'from',
      codecs: null,
      hosts: [
        {
          priority: 1,
          host: 'sip.provider-c.example',
          port: 5061,
          direction: 'both'
        }
      ]
    }
  ],
  moh: [
    { id: 'm1', filename: 'track1.wav' },
    { id: 'm2', filename: 'track2.wav' }
  ]
};

// The fixture above always carries these; named so the tests below can spread and tweak one
// without indexing into `input.trunks`/`input.devices` themselves (an array index read).
const [trunkA, trunkB] = input.trunks;
const [deviceA] = input.devices;
if (trunkA === undefined || trunkB === undefined || deviceA === undefined) {
  throw new Error('render test: fixture is missing a trunk or device');
}

describe('render', () => {
  const rendered = render(input);

  test('pjsip_users.conf matches the fixture', () => {
    expect(rendered['pjsip_users.conf']).toBe(fixture('pjsip_users.conf'));
  });

  test('pjsip_trunks.conf matches the fixture', () => {
    expect(rendered['pjsip_trunks.conf']).toBe(fixture('pjsip_trunks.conf'));
  });

  test('extensions_hints.conf matches the fixture', () => {
    expect(rendered['extensions_hints.conf']).toBe(
      fixture('extensions_hints.conf')
    );
  });

  test('musiconhold.conf matches the fixture', () => {
    expect(rendered['musiconhold.conf']).toBe(fixture('musiconhold.conf'));
  });

  test('devices are identified by digest auth username', () => {
    expect(rendered['pjsip_users.conf']).toContain(
      'identify_by = auth_username'
    );
  });

  test('the ip trunk with inbound_auth and a host list takes its credential only from those hosts', () => {
    // Trunk B (t2) has `inbound_auth` and an `inbound`/`both` host list: the `identify` section's
    // source-address match leads to `trunk-<id>`, which challenges, and no endpoint named by the
    // username takes the credential from elsewhere (§5.6, §9.4 "Inbound identification").
    const trunksConf = rendered['pjsip_trunks.conf'];
    expect(trunksConf).toContain(
      '[trunk-t2]\ntype = identify\nendpoint = trunk-t2\n'
    );
    expect(trunksConf).toContain('auth = trunk-t2\nidentify_by = ip\n');
    expect(trunksConf).not.toContain('[ipuser]\ntype = endpoint\n');
    expect(trunksConf).not.toContain('identify_by = auth_username');
  });

  // Trunk B with its one dialled host alone, so no source address identifies its calls.
  const noHosts: RenderInput = {
    ...input,
    users: [],
    devices: [],
    ringGroups: [],
    parkingSlots: [],
    trunks: [
      {
        ...trunkB,
        hosts: [
          {
            priority: 1,
            host: '203.0.113.10',
            port: null,
            direction: 'outbound'
          }
        ]
      }
    ]
  };

  test('an inbound_auth trunk without source hosts is identified by an endpoint named by its username', () => {
    // Asterisk's `identify_by = auth_username` finds the endpoint whose name is the
    // Authorization username; `trunk-<id>` never is, so the digest match needs a section named
    // by the trunk's username, bound to the trunk's own auth section (§9.4, §5.6).
    const section = render(noHosts)
      ['pjsip_trunks.conf'].split('\n\n')
      .find(block => block.startsWith('[ipuser]\n'))
      ?.trimEnd();
    expect(section).toBe(
      [
        '[ipuser]',
        'type = endpoint',
        'context = from-trunk',
        'allow = !all,ulaw',
        'transport = transport-tcp',
        'direct_media = no',
        'send_connected_line = no',
        'send_diversion = no',
        'dtmf_mode = auto',
        'auth = trunk-t2',
        'identify_by = auth_username'
      ].join('\n')
    );
  });

  test("every trunk endpoint is identified by source address or line tag alone, never by a From user of its section's name", () => {
    const sections = rendered['pjsip_trunks.conf']
      .split('\n\n')
      .filter(block => /^\[trunk-[^\]]+\]\ntype = endpoint\n/u.test(block));
    expect(sections).toHaveLength(3);
    for (const section of sections) {
      expect(section.split('\n')).toContain('identify_by = ip');
    }
  });

  test('an inbound_auth trunk with no host list is identified by auth username alone', () => {
    const trunksConf = render(noHosts)['pjsip_trunks.conf'];
    expect(trunksConf).toContain('[ipuser]\n');
    expect(trunksConf).toContain('identify_by = auth_username');
    // `trunk-<id>` keeps `identify_by = ip`, which with no `identify` section matches nothing.
    expect(trunksConf).not.toContain('type = identify');
  });

  test('a registration trunk registers to the registrar host, never an inbound-only host', () => {
    const trunksConf = rendered['pjsip_trunks.conf'];
    expect(trunksConf).toContain(
      'client_uri = sip:trunkuser@sip.provider-a.example'
    );
    expect(trunksConf).toContain('server_uri = sip:sip.provider-a.example');
    expect(trunksConf).not.toContain('198.51.100.5@');
    expect(trunksConf).not.toContain('server_uri = sip:198.51.100.5');
  });

  test("a registration trunk registers its account name as the contact's user (§9.4)", () => {
    // Asterisk's default contact user is `s`, which a provider's INVITE to the registered
    // contact would deliver as the called party instead of the account name a DID can match.
    const registrationSection =
      rendered['pjsip_trunks.conf']
        .split('type = registration')[1]
        ?.split('\n\n')[0] ?? '';
    expect(registrationSection.split('\n')).toContain(
      'contact_user = trunkuser'
    );
    const ipTrunk = rendered['pjsip_trunks.conf'].split('[trunk-t2]').slice(1);
    expect(ipTrunk.join('')).not.toContain('contact_user');
  });

  test('the ip trunk aor is qualified so ContactStatusChange events fire', () => {
    const t2Aor = rendered['pjsip_trunks.conf']
      .split('[trunk-t2]\ntype = aor')[1]
      ?.split('\n\n')[0];
    expect(t2Aor).toContain('qualify_frequency = 60');
  });

  test('an ip trunk with qualify off is never probed', () => {
    const t3Aor = rendered['pjsip_trunks.conf']
      .split('[trunk-t3]\ntype = aor')[1]
      ?.split('\n\n')[0];
    expect(t3Aor).toContain('qualify_frequency = 0');
  });

  test('the registration trunk aor carries no qualify_frequency', () => {
    const trunksConf = rendered['pjsip_trunks.conf'];
    const t1Aor = trunksConf.split('[trunk-t2]')[0];
    expect(t1Aor).not.toContain('qualify_frequency');
  });

  test('trunk endpoints keep media through Asterisk', () => {
    expect(rendered['pjsip_trunks.conf']).toContain('direct_media = no');
  });

  test('a pai trunk endpoint sends P-Asserted-Identity', () => {
    const trunksConf = rendered['pjsip_trunks.conf'];
    expect(trunksConf).toContain('send_pai = yes');
    expect(trunksConf).toContain('trust_id_outbound = yes');
  });

  test("a pai trunk's From is its account at the registrar, where the asserted number is too", () => {
    const t2Section = rendered['pjsip_trunks.conf'].split(
      '[trunk-t2]\ntype = endpoint'
    )[1];
    expect(t2Section).toContain(
      'from_user = ipuser\nfrom_domain = 203.0.113.10\n'
    );
  });

  test('a both trunk asserts the number it presents in From, which it leaves to the caller ID', () => {
    const conf = render({
      ...input,
      trunks: [{ ...trunkB, callerIdHeader: 'both' }]
    })['pjsip_trunks.conf'];
    expect(conf).toContain('send_pai = yes\ntrust_id_outbound = yes\n');
    expect(conf).not.toContain('from_user');
    expect(conf).not.toContain('from_domain');
  });

  test('a from-only trunk endpoint sends no P-Asserted-Identity', () => {
    const trunksConf = rendered['pjsip_trunks.conf'];
    const t1Section = trunksConf.split('[trunk-t2]')[0];
    expect(t1Section).not.toContain('send_pai');
  });

  test('device aors carry the owner mailbox and each of their ring group mailboxes', () => {
    expect(rendered['pjsip_users.conf']).toContain(
      'mailboxes = user:u1,ringGroup:rg1'
    );
  });

  test('the plain device carries its allowed-IP permit line', () => {
    expect(rendered['pjsip_users.conf']).toContain('permit = 10.0.0.0/8');
  });

  test('the plain endpoint denies every address before permitting the allowlist', () => {
    const plainSection =
      rendered['pjsip_users.conf']
        .split('[e101-d3kx7]\ntype = endpoint')[1]
        ?.split('\n\n')[0] ?? '';
    const lines = plainSection.split('\n');
    expect(lines).toContain('deny = 0.0.0.0/0');
    expect(lines).toContain('deny = ::/0');
    expect(lines.indexOf('deny = 0.0.0.0/0')).toBeLessThan(
      lines.indexOf('permit = 10.0.0.0/8')
    );
    expect(lines.indexOf('deny = ::/0')).toBeLessThan(
      lines.indexOf('permit = 10.0.0.0/8')
    );
  });

  test('the tls endpoint carries no ACL line', () => {
    const tlsSection = rendered['pjsip_users.conf'].split(
      '[e101-dz9k2]\ntype = endpoint'
    )[1];
    expect(tlsSection).not.toContain('deny = ');
    expect(tlsSection).not.toContain('permit = ');
  });

  test('the ringotel device gets the tenant max_contacts and remove_existing', () => {
    expect(rendered['pjsip_users.conf']).toContain('max_contacts = 3');
    expect(rendered['pjsip_users.conf']).toContain('remove_existing = yes');
  });

  test('the manual device is capped at one contact', () => {
    expect(rendered['pjsip_users.conf']).toContain('max_contacts = 1');
  });

  test('every device endpoint carries the NAT and codec attributes', () => {
    const usersConf = rendered['pjsip_users.conf'];
    expect(usersConf).toContain('rewrite_contact = yes');
    expect(usersConf).toContain('rtp_symmetric = yes');
    expect(usersConf).toContain('force_rport = yes');
    expect(usersConf).toContain('direct_media = no');
    expect(usersConf).toContain('allow = !all,opus,g722,alaw');
  });

  test('the hints file has one hint per user, ring group and parking slot', () => {
    const hints = rendered['extensions_hints.conf'];
    expect(hints).toContain('exten => 101,hint,Stasis:presence-101');
    expect(hints).toContain('exten => 600,hint,Stasis:presence-600');
    expect(hints).toContain('exten => 701,hint,Stasis:presence-701');
  });

  test('musiconhold.conf has one files-mode class per moh asset', () => {
    const moh = rendered['musiconhold.conf'];
    expect(moh).toContain('mode = files');
    expect(moh).toContain('directory = /media/prompts/moh/m1/');
    expect(moh).toContain('directory = /media/prompts/moh/m2/');
  });

  test('render refuses an invalid extension', () => {
    const bad: RenderInput = {
      ...input,
      users: [
        { id: 'u1', ext: '101,same => n,Hangup()', name: 'A', ringGroupIds: [] }
      ],
      devices: [],
      ringGroups: [],
      parkingSlots: [],
      trunks: []
    };
    expect(() => render(bad)).toThrow(/invalid extension/u);
  });

  test('a registration trunk with an outbound proxy sends its registration and its static contact through it', () => {
    const withProxy: RenderInput = {
      ...input,
      users: [],
      devices: [],
      ringGroups: [],
      parkingSlots: [],
      trunks: [{ ...trunkA, outboundProxy: 'sip:sbc.provider-a.example' }]
    };
    const trunksConf = render(withProxy)['pjsip_trunks.conf'];
    const aorSection = trunksConf.split('type = identify')[0];
    const registrationSection = trunksConf
      .split('type = registration')[1]
      ?.split('type = endpoint')[0];
    expect(aorSection).toContain('outbound_proxy = sip:sbc.provider-a.example');
    expect(registrationSection).toContain(
      'outbound_proxy = sip:sbc.provider-a.example'
    );
  });

  test('an ip trunk without inbound_auth gets no auth section at all', () => {
    const noInboundAuth: RenderInput = {
      ...input,
      users: [],
      devices: [],
      ringGroups: [],
      parkingSlots: [],
      trunks: [{ ...trunkB, inboundAuth: false }]
    };
    const trunksConf = render(noInboundAuth)['pjsip_trunks.conf'];
    expect(trunksConf).not.toContain('type = auth');
    expect(trunksConf).not.toContain('outbound_auth');
    expect(trunksConf).not.toContain('identify_by = auth_username');
  });

  test('render refuses a trunk password carrying a newline', () => {
    const bad: RenderInput = {
      ...input,
      users: [],
      devices: [],
      ringGroups: [],
      parkingSlots: [],
      trunks: [{ ...trunkA, password: 'x\n[anonymous]\ntype=endpoint' }]
    };
    expect(() => render(bad)).toThrow(/unsafe value/u);
  });

  test('render refuses a trunk host carrying a newline', () => {
    const bad: RenderInput = {
      ...input,
      users: [],
      devices: [],
      ringGroups: [],
      parkingSlots: [],
      trunks: [
        {
          ...trunkA,
          hosts: [
            {
              priority: 1,
              host: 'sip.example\n[anonymous]',
              port: null,
              direction: 'both'
            }
          ]
        }
      ]
    };
    expect(() => render(bad)).toThrow(/unsafe value/u);
  });

  test('render refuses a device sipUsername carrying a bracket', () => {
    const bad: RenderInput = {
      ...input,
      ringGroups: [],
      parkingSlots: [],
      trunks: [],
      devices: [{ ...deviceA, sipUsername: 'e101]\n[anonymous' }]
    };
    expect(() => render(bad)).toThrow(/unsafe value/u);
  });

  test('render refuses a device allowed-IP entry carrying a newline', () => {
    const bad: RenderInput = {
      ...input,
      ringGroups: [],
      parkingSlots: [],
      trunks: [],
      devices: [{ ...deviceA, allowedIps: ['10.0.0.0/8\n[anonymous]'] }]
    };
    expect(() => render(bad)).toThrow(/unsafe value/u);
  });

  test('render refuses a ring group id carrying a bracket', () => {
    const bad: RenderInput = {
      ...input,
      users: [
        {
          id: 'u1',
          ext: '101',
          name: 'A',
          ringGroupIds: ['rg1]\n[anonymous']
        }
      ],
      ringGroups: [],
      parkingSlots: [],
      trunks: []
    };
    expect(() => render(bad)).toThrow(/unsafe value/u);
  });

  test('render refuses a moh asset id carrying a bracket', () => {
    const bad: RenderInput = {
      ...input,
      users: [],
      devices: [],
      ringGroups: [],
      parkingSlots: [],
      trunks: [],
      moh: [{ id: 'm1]\n[anonymous', filename: 'track1.wav' }]
    };
    expect(() => render(bad)).toThrow(/unsafe value/u);
  });

  test('render refuses a moh asset id that would escape the media directory', () => {
    const bad: RenderInput = {
      ...input,
      users: [],
      devices: [],
      ringGroups: [],
      parkingSlots: [],
      trunks: [],
      moh: [{ id: '../../etc', filename: 'track1.wav' }]
    };
    expect(() => render(bad)).toThrow(/unsafe value/u);
  });

  test('render refuses a trunk id carrying a bracket', () => {
    const bad: RenderInput = {
      ...input,
      users: [],
      devices: [],
      ringGroups: [],
      parkingSlots: [],
      trunks: [{ ...trunkA, id: 't1]\n[anonymous' }]
    };
    expect(() => render(bad)).toThrow(/unsafe value/u);
  });

  /** The endpoint section of `input`'s first device, rendered with `patch` applied. */
  function firstEndpoint(patch: Partial<RenderInput>): string[] {
    const users = render({ ...input, ...patch })['pjsip_users.conf'];
    const section = users
      .split('\n\n')
      .find(block => block.includes('type = endpoint'));
    return (section ?? '').split('\n');
  }

  test("a device's caller ID is its owner's name and extension, so calls carry the extension (§11.2 calls.from_uri)", () => {
    const lines = firstEndpoint({
      users: [
        {
          id: 'u1',
          ext: '101',
          name: 'Anna "Annie" Huber;\n[anonymous]',
          ringGroupIds: []
        }
      ]
    });
    // The quote and the line break are dropped, the `;` escaped; the bracket stays harmlessly
    // inside the value, which no longer starts a line.
    expect(lines).toContain(
      'callerid = "Anna Annie Huber\\;[anonymous]" <101>'
    );
    expect(lines.filter(line => line.startsWith('['))).toHaveLength(1);
  });

  test('render refuses a device whose owner is not among the users', () => {
    expect(() => render({ ...input, users: [] })).toThrow(/no owner/u);
  });

  test('a held party hears the hold class every device endpoint suggests (§10.2 "Hold music")', () => {
    const lines = firstEndpoint({
      settings: { ...input.settings, holdMohClass: 'default' }
    });
    expect(lines).toContain('moh_suggest = default');
  });

  test('render refuses a hold class that is no bare id', () => {
    expect(() =>
      render({
        ...input,
        settings: { ...input.settings, holdMohClass: 'm1\n[anonymous]' }
      })
    ).toThrow(/unsafe value/u);
  });
});
