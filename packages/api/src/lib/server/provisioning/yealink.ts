/**
 * The Yealink configuration file a provisioning link serves (§10.4 "Provisioning link"), for the
 * T7x/T8x firmware line (tested on the T87W). Every key and value follows Yealink's own admin
 * guide for that line; the file is written from Zamfono's data alone, never from a vendor
 * template.
 */
import * as env from '$app/env/private';

import {
  featureCodesColumn,
  type Codec,
  type Db,
  type FeatureCodes,
  type Language
} from '@zamfono/shared';

import {
  connectionSettings,
  type ConnectionSettings
} from '../ops/devices/_connectionSettings.js';
import { loadDeviceKeys, type DeviceKey } from '../ops/devices/_keys.js';
import type { DeviceRow } from '../ops/devices/_shared.js';
import { loadSettings } from '../ops/settings/_shared.js';
import { decrypt, keyringFromEnv } from '../secretbox.js';
import { STUN_PORT } from '../stackAddress.js';
import { tenantTimeZone } from '../tenantTimeZone.js';
import { blfEntries } from './ringotelRoster.js';
import { timeZoneLines } from './yealinkTimeZones.js';

/** The phone's built-in ringtones, the values `devices.ringtone` takes. */
export const YEALINK_RINGTONES = [
  'Ring1.wav',
  'Ring2.wav',
  'Ring3.wav',
  'Ring4.wav',
  'Ring5.wav',
  'Ring6.wav',
  'Ring7.wav',
  'Ring8.wav',
  'Silent.wav',
  'Splash.wav'
] as const;

// The T87W's line keys, the most of the line; a model with fewer ignores the rest.
const LINE_KEYS = 84;

const KEY_TYPE = {
  none: 0,
  callPark: 10,
  speedDial: 13,
  line: 15,
  blf: 16
} as const;
const TRANSPORT_TLS = 2;
const SRTP_COMPULSORY = 2;

// Yealink's codec names for Zamfono's (§9.1). The T7x/T8x line has no Opus, and AMR has no
// documented key, so a tenant's `opus` or `amr*` is left out and the phone offers the rest.
const CODEC_NAMES: Partial<Record<Codec, string>> = {
  g722: 'g722',
  alaw: 'pcma',
  ulaw: 'pcmu'
};
const YEALINK_CODECS = [
  'g722',
  'pcmu',
  'pcma',
  'g729',
  'g726_16',
  'g726_24',
  'g726_32',
  'g726_40',
  'ilbc'
];

const LANGUAGE_NAMES: Record<Language, string> = {
  de: 'German',
  en: 'English',
  es: 'Spanish',
  fr: 'French',
  it: 'Italian',
  ru: 'Russian'
};

/** One line key: an extension with its label (its owner's name, "Parking 701"), or a list entry. */
export type YealinkKey =
  | (Extract<DeviceKey, { kind: 'blf' }> & { title: string })
  | Exclude<DeviceKey, { kind: 'blf' }>;

/** Everything one file is rendered from, already read and decrypted. */
export type YealinkInput = {
  settings: ConnectionSettings;
  label: string;
  keys: YealinkKey[];
  codes: Pick<
    FeatureCodes,
    'dndToggle' | 'mailbox' | 'ownVoicemail' | 'park' | 'pickup'
  >;
  timeZone: string;
  language: Language;
  ringtone: string | null;
  adminPassword: string;
  stunServer: string;
  now: Date;
};

type Line = [string, string | number];

/** `value` on one line: a line break in a name or label would start a setting of its own. */
function oneLine(value: string): string {
  return value.replace(/\p{Cc}+/gu, ' ');
}

/** One line key's settings. */
function keyLines(input: YealinkInput, key: YealinkKey): Line[] {
  switch (key.kind) {
    case 'line':
      // The device's label, as the account's, so no label of the key this one was before lingers.
      return [
        ['type', KEY_TYPE.line],
        ['label', input.label]
      ];
    case 'blf':
      // Pressed while the extension rings, the key dials this code and the extension (§9.3).
      return [
        ['type', KEY_TYPE.blf],
        ['value', key.ext],
        ['label', key.title],
        ['extension', input.codes.pickup]
      ];
    case 'mailbox':
      // A BLF key on the mailbox's hint: lit while it holds new messages, opening it when pressed.
      return [
        ['type', KEY_TYPE.blf],
        ['value', `${input.codes.mailbox}${key.ext}`],
        ['label', key.label]
      ];
    case 'empty':
      return [['type', KEY_TYPE.none]];
    case 'quickDial':
      return [
        ['type', KEY_TYPE.speedDial],
        ['value', key.number],
        ['label', key.label]
      ];
    case 'feature':
      // `dndToggle`: a BLF key on the user's DND hint, lit while DND is on, toggling it (§9.3).
      // `park`: the phone's park key, holding the call and dialling the code; the slot is read out.
      if (key.feature === 'park') {
        return [
          ['type', KEY_TYPE.callPark],
          ['value', ''],
          ['label', key.label]
        ];
      }
      return key.feature === 'dndToggle'
        ? [
            ['type', KEY_TYPE.blf],
            ['value', `${input.codes.dndToggle}${input.settings.extension}`],
            ['label', key.label]
          ]
        : [
            ['type', KEY_TYPE.speedDial],
            ['value', input.codes[key.feature]],
            ['label', key.label]
          ];
    default:
      throw new Error(`yealink: unknown key kind '${String(key)}'`);
  }
}

/** The line keys: the key list in order, then every other key emptied. */
function lineKeyLines(input: YealinkInput): Line[] {
  const out: Line[] = [];
  for (let keyNo = 1; keyNo <= LINE_KEYS; keyNo++) {
    const key = input.keys[keyNo - 1] ?? { kind: 'empty' };
    const fields: Line[] =
      key.kind === 'empty'
        ? keyLines(input, key)
        : [['line', 1], ...keyLines(input, key)];
    for (const [field, value] of fields) {
      out.push([`linekey.${keyNo}.${field}`, value]);
    }
  }
  return out;
}

/** The account's server: SIP over TLS with SRTP compulsory, a `yealink` device being `tls` (§11.2). */
function serverLines(cs: ConnectionSettings): Line[] {
  return [
    ['account.1.sip_server.1.address', cs.server],
    ['account.1.sip_server.1.port', cs.port],
    ['account.1.sip_server.1.transport_type', TRANSPORT_TLS],
    ['account.1.srtp_encryption', SRTP_COMPULSORY]
  ];
}

/** Each Yealink codec on or off, the tenant's in their order. */
function codecLines(cs: ConnectionSettings): Line[] {
  return YEALINK_CODECS.flatMap((name): Line[] => {
    const position = cs.codecs.findIndex(codec => CODEC_NAMES[codec] === name);
    return position === -1
      ? [[`account.1.codec.${name}.enable`, 0]]
      : [
          [`account.1.codec.${name}.enable`, 1],
          [`account.1.codec.${name}.priority`, position + 1]
        ];
  });
}

/** The configuration file for `input` (§10.4 "Provisioning link"). */
export function renderYealink(input: YealinkInput): string {
  const cs = input.settings;
  const lines: Line[] = [
    ['account.1.enable', 1],
    ['account.1.label', input.label],
    ['account.1.display_name', cs.displayName],
    ['account.1.auth_name', cs.username],
    ['account.1.user_name', cs.username],
    ['account.1.password', cs.password],
    ...serverLines(cs),
    ...codecLines(cs),
    ['account.1.subscribe_mwi', 1],
    ['voice_mail.number.1', input.codes.ownVoicemail],
    // DND and forwarding live in the core (§9.3); feature keys dial its codes.
    ['features.dnd.allow', 0],
    ['features.fwd.allow', 0],
    // FAC mode: the Park soft key and any park key hold the call and dial the park code (§10.2).
    ['features.call_park.enable', 1],
    ['features.call_park.park_mode', 1],
    ['features.call_park.park_code', input.codes.park],
    ['static.sip.nat_stun.enable', 1],
    ['static.sip.nat_stun.server', input.stunServer],
    ['static.sip.nat_stun.port', STUN_PORT],
    ['account.1.nat.nat_traversal', 1],
    ['static.security.trust_certificates', 1],
    ['static.security.cn_validation', 1],
    ['sip.trust_ctrl', 1],
    // Both web accounts, or the phone warns that `user` keeps its factory one.
    ['static.security.user_password', `admin:${input.adminPassword}`],
    ['static.security.user_password', `user:${input.adminPassword}`],
    ['static.auto_provision.power_on', 1],
    ['static.auto_provision.weekly.enable', 1],
    ['static.auto_provision.weekly.dayofweek', '0123456'],
    ['static.auto_provision.weekly.begin_time', '01:00'],
    ['static.auto_provision.weekly.end_time', '05:00'],
    ...timeZoneLines(input.timeZone, input.now),
    ['local_time.ntp_server1', 'pool.ntp.org'],
    ['lang.gui', LANGUAGE_NAMES[input.language]],
    ['lang.wui', LANGUAGE_NAMES[input.language]],
    ...(input.ringtone === null
      ? []
      : [['phone_setting.ring_type', input.ringtone] satisfies Line]),
    // 0 ms on per blink: no blinking power LED in power-saving mode.
    ['features.power_saving.power_led_flash.on_time', 0],
    ...lineKeyLines(input)
  ];
  const body = lines.map(
    ([key, value]) => `${key} = ${oneLine(String(value))}`
  );
  return `#!version:1.0.0.1\n${body.join('\n')}\n`;
}

/** The file for live `yealink` `device`, every value read from its source now. */
export async function yealinkFile(db: Db, device: DeviceRow): Promise<string> {
  const password = decrypt(
    keyringFromEnv(env),
    'devices.sipPasswordEnc',
    device.sipPasswordEnc
  ).toString('utf8');
  const settings = await loadSettings(db);
  const codes = featureCodesColumn.decode(settings.featureCodesJson);
  const keys = await loadDeviceKeys(db, device.id);
  const titles = new Map(
    (
      await blfEntries(
        db,
        keys.flatMap(key => (key.kind === 'blf' ? [key.ext] : []))
      )
    ).map(entry => [entry.number, entry.title])
  );
  const cs = await connectionSettings(db, device, password);
  return renderYealink({
    settings: cs,
    label: device.label,
    keys: keys.map(key =>
      key.kind === 'blf'
        ? { ...key, title: titles.get(key.ext) ?? key.ext }
        : key
    ),
    codes,
    timeZone: tenantTimeZone(settings.timezone),
    language: settings.language,
    ringtone: device.ringtone,
    // A `yealink` device always has one (§11.2 `devices` CHECK).
    adminPassword: cs.adminPassword ?? '',
    stunServer: env.FQDN,
    now: new Date()
  });
}
