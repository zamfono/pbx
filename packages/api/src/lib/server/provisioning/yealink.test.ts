import { describe, expect, it } from 'vitest';

import { renderYealink, type YealinkInput } from './yealink.js';
import {
  TIME_ZONES,
  utcOffsetMinutes,
  yealinkOffset
} from './yealinkTimeZones.js';

const codes = {
  dndToggle: '*92',
  mailbox: '*95',
  ownVoicemail: '*96',
  park: '*70',
  pickup: '*8'
};

function input(overrides: Partial<YealinkInput> = {}): YealinkInput {
  return {
    settings: {
      server: 'pbx.example.com',
      domain: 'pbx.example.com',
      transport: ['tls'],
      port: 5061,
      username: 'e205-dab3kx',
      password: 'sippw',
      extension: '205',
      displayName: 'Anna Huber',
      mediaEncryption: 'srtp',
      codecs: ['g722', 'alaw'],
      voicemailCode: '*96',
      adminPassword: 'adminpw'
    },
    label: 'Desk',
    keys: [
      { kind: 'line' },
      { kind: 'blf', ext: '206', title: 'Ben' },
      { kind: 'quickDial', number: '+43123456789', label: 'Taxi' },
      { kind: 'feature', feature: 'dndToggle', label: 'DND' },
      { kind: 'mailbox', ext: '600', label: 'Support VM' }
    ],
    codes,
    timeZone: 'Europe/Vienna',
    language: 'de',
    ringtone: 'Ring3.wav',
    adminPassword: 'adminpw',
    stunServer: 'pbx.example.com',
    now: new Date('2026-10-21T08:00:00Z'),
    ...overrides
  };
}

/** The file's settings as a map, after checking its header. */
function parse(file: string): Map<string, string> {
  const [header, ...lines] = file.trimEnd().split('\n');
  expect(header).toBe('#!version:1.0.0.1');
  return new Map(
    lines.map(line => {
      const at = line.indexOf(' = ');
      return [line.slice(0, at), line.slice(at + 3)];
    })
  );
}

describe('renderYealink (§10.4 "Provisioning link")', () => {
  it('TLS with compulsory SRTP, the keys, the phone set up around the PBX', () => {
    const file = parse(renderYealink(input()));
    expect(
      Object.fromEntries(
        [...file].filter(([key]) => !key.startsWith('linekey.'))
      )
    ).toEqual({
      'account.1.enable': '1',
      'account.1.label': 'Desk',
      'account.1.display_name': 'Anna Huber',
      'account.1.auth_name': 'e205-dab3kx',
      'account.1.user_name': 'e205-dab3kx',
      'account.1.password': 'sippw',
      'account.1.sip_server.1.address': 'pbx.example.com',
      'account.1.sip_server.1.port': '5061',
      'account.1.sip_server.1.transport_type': '2',
      'account.1.srtp_encryption': '2',
      'account.1.codec.g722.enable': '1',
      'account.1.codec.g722.priority': '1',
      'account.1.codec.pcmu.enable': '0',
      'account.1.codec.pcma.enable': '1',
      'account.1.codec.pcma.priority': '2',
      'account.1.codec.g729.enable': '0',
      'account.1.codec.g726_16.enable': '0',
      'account.1.codec.g726_24.enable': '0',
      'account.1.codec.g726_32.enable': '0',
      'account.1.codec.g726_40.enable': '0',
      'account.1.codec.ilbc.enable': '0',
      'account.1.subscribe_mwi': '1',
      'voice_mail.number.1': '*96',
      'features.dnd.allow': '0',
      'features.fwd.allow': '0',
      'static.sip.nat_stun.enable': '1',
      'static.sip.nat_stun.server': 'pbx.example.com',
      'static.sip.nat_stun.port': '3478',
      'account.1.nat.nat_traversal': '1',
      'static.security.trust_certificates': '1',
      'static.security.cn_validation': '1',
      'sip.trust_ctrl': '1',
      // The map keeps the last of the two lines; the next test checks both.
      'static.security.user_password': 'user:adminpw',
      'static.auto_provision.power_on': '1',
      'static.auto_provision.weekly.enable': '1',
      'static.auto_provision.weekly.dayofweek': '0123456',
      'static.auto_provision.weekly.begin_time': '01:00',
      'static.auto_provision.weekly.end_time': '05:00',
      'local_time.time_zone': '+1',
      'local_time.time_zone_name': 'Austria(Vienna)',
      'local_time.summer_time': '2',
      'local_time.ntp_server1': 'pool.ntp.org',
      'lang.gui': 'German',
      'lang.wui': 'German',
      'phone_setting.ring_type': 'Ring3.wav',
      'features.power_saving.power_led_flash.on_time': '0'
    });
    expect(
      ['type', 'line', 'label'].map(field => file.get(`linekey.1.${field}`))
    ).toEqual(['15', '1', 'Desk']);
    expect(
      ['type', 'value', 'label', 'extension'].map(field =>
        file.get(`linekey.2.${field}`)
      )
    ).toEqual(['16', '206', 'Ben', '*8']);
    expect(
      ['type', 'value', 'label'].map(field => file.get(`linekey.3.${field}`))
    ).toEqual(['13', '+43123456789', 'Taxi']);
    expect(
      ['type', 'value', 'label'].map(field => file.get(`linekey.4.${field}`))
    ).toEqual(['16', '*92205', 'DND']);
    expect(
      ['type', 'value', 'label'].map(field => file.get(`linekey.5.${field}`))
    ).toEqual(['16', '*95600', 'Support VM']);
    expect(file.get('linekey.6.type')).toBe('0');
    expect(file.get('linekey.84.type')).toBe('0');
    expect(file.has('linekey.85.type')).toBe(false);
  });

  it('sets the admin password on both web accounts, admin and user', () => {
    const file = renderYealink(input());
    expect(file).toMatch(/^static\.security\.user_password = admin:adminpw$/mu);
    expect(file).toMatch(/^static\.security\.user_password = user:adminpw$/mu);
  });

  it('no ringtone leaves the phone its own, and an empty key list leaves no keys', () => {
    const file = parse(renderYealink(input({ ringtone: null, keys: [] })));
    expect(file.has('phone_setting.ring_type')).toBe(false);
    expect(file.get('linekey.1.type')).toBe('0');
  });

  it('keeps a line break in a name or label from starting a setting of its own', () => {
    const file = renderYealink(
      input({
        label: 'Desk\nstatic.security.user_password = admin:x',
        keys: [
          {
            kind: 'quickDial',
            number: '+43123456789',
            label: 'a\r\nsip.trust_ctrl = 0'
          }
        ]
      })
    );
    expect(file).not.toMatch(/^static\.security\.user_password = admin:x$/mu);
    expect(file).not.toMatch(/^sip\.trust_ctrl = 0$/mu);
    expect(parse(file).get('sip.trust_ctrl')).toBe('1');
  });

  it('a zone without a Yealink name gets its current offset and no DST rules', () => {
    const file = parse(renderYealink(input({ timeZone: 'Asia/Kathmandu' })));
    expect(file.get('local_time.time_zone')).toBe('+5:45');
    expect(file.get('local_time.summer_time')).toBe('0');
    expect(file.has('local_time.time_zone_name')).toBe(false);
  });

  it('writes offsets in Yealink form', () => {
    expect([0, 60, -210, 345, -600].map(yealinkOffset)).toEqual([
      '0',
      '+1',
      '-3:30',
      '+5:45',
      '-10'
    ]);
    expect(
      utcOffsetMinutes('Europe/Vienna', new Date('2026-07-01T00:00:00Z'))
    ).toBe(120);
  });

  it('maps each IANA zone onto a Yealink zone of the same standard offset', () => {
    for (const [zone, [offset]] of Object.entries(TIME_ZONES)) {
      const standard = Math.min(
        ...['2026-01-15', '2026-07-15'].map(day =>
          utcOffsetMinutes(zone, new Date(`${day}T12:00:00Z`))
        )
      );
      expect([zone, yealinkOffset(standard)]).toEqual([zone, offset]);
    }
  });
});
