import { validateFeatureCodes, type FeatureCodes } from '@zamfono/shared';

import type { SettingsRow } from './types.js';

const CODEC_FRAME_MS = 20;
// A registration Asterisk lost, to a restart, comes back within two minutes even when the
// re-registration a restart triggers (§10.4) does not reach Ringotel; PJSIP accepts 60 s and up.
const REGISTRATION_TTL_S = 120;

/** Ringotel's own codec names (§10.4): G.722 has no match and is dropped. */
const RINGOTEL_CODEC_NAMES = {
  opus: 'Opus',
  alaw: 'G.711 Alaw',
  ulaw: 'G.711 Ulaw'
};

export type BranchProvision = {
  protocol: 'sips';
  nosrtp: false;
  codecs: { codec: string; frame: number }[];
  dtmfmode: 'rfc2833';
  features: 'pbx';
  dnd: { on: string; off: string };
  vmail: { ext: string; unsolicited: false };
  forwarding: {
    cfuon: '';
    cfboff: '';
    cfon: '';
    cfbon: '';
    cfuoff: '';
    cfoff: '';
  };
  callpark: { park: string; slots: { alias: string; slot: string }[] };
  // The keys below were read back with `getBranches` after toggling one Shell control at a time
  // (§10.4), as docs/ringotel.yaml documents them. `updateBranch` merges `provision` keys,
  // so a key once sent and later left out keeps its last value at Ringotel.
  /** 1 = "Route internal calls through PBX only" (2, "…if possible", is Ringotel's default). */
  internalRouting: 1;
  /** "Route users' calls to their extension number through PBX". */
  extst: true;
  /** "Route video calls through PBX". */
  extvc: true;
  /** "Keep registrations when users are offline": a closed app stays reachable for its push. */
  keepreg: true;
  /** "Prioritize Caller Name from the PBX": the core's caller-ID name wins over app contacts. */
  keepCallerName: true;
  /** The registration TTL in seconds (Ringotel's default 3600). */
  regexpires: number;
  /** Incoming-number rewriting, "" = disabled: the core already normalizes numbers (§9.4). */
  inboundFormat: '';
  /** The caller-ID name the app sends when calling the PBX; empty, since the core sets it. */
  displayname: '';
  // A Ringotel user registers up to this many times (§10.4); moves with `settings.ringotelMaxRegs`.
  maxregs: number;
  // The tenant-wide colleague presence panel (§10.4 "Colleague presence"), one entry per
  // extension; every push carries it, as it carries every key, so each push states the whole profile.
  blfs: { number: string; title: string }[];
};

/**
 * The Ringotel branch `provision` object (§10.4 "Branch provision profile"), every key Zamfono
 * owns, pushed at setup and on every `updateBranch` push, so a Shell edit to one of them is
 * overwritten; Ringotel merges the keys into what it stores. `blfs` is the caller's
 * current tenant-wide presence list (empty at first setup), so every push carries the same keys.
 */
export function buildBranchProvision(
  settings: Pick<
    SettingsRow,
    'codecsJson' | 'featureCodesJson' | 'ringotelMaxRegs'
  >,
  parkingSlots: string[],
  blfs: { number: string; title: string }[]
): BranchProvision {
  const codecs = (JSON.parse(settings.codecsJson) as string[])
    .filter(
      (codec): codec is keyof typeof RINGOTEL_CODEC_NAMES =>
        codec in RINGOTEL_CODEC_NAMES
    )
    .map(codec => ({
      codec: RINGOTEL_CODEC_NAMES[codec],
      frame: CODEC_FRAME_MS
    }));
  const featureCodes: FeatureCodes = validateFeatureCodes(
    JSON.parse(settings.featureCodesJson)
  );
  return {
    protocol: 'sips',
    nosrtp: false,
    codecs,
    dtmfmode: 'rfc2833',
    features: 'pbx',
    dnd: { on: featureCodes.dndOn, off: featureCodes.dndOff },
    vmail: { ext: featureCodes.ownVoicemail, unsolicited: false },
    forwarding: {
      cfuon: '',
      cfboff: '',
      cfon: '',
      cfbon: '',
      cfuoff: '',
      cfoff: ''
    },
    callpark: {
      park: featureCodes.park,
      slots: parkingSlots.map(ext => ({ alias: `Parking ${ext}`, slot: ext }))
    },
    // Internal calls pass through the core, since history, recording and presence depend on it
    // seeing every call, and the core's caller-ID name wins over app-local contacts (§10.4).
    // `internal` is not sent: the Shell clears that legacy key unless `internalRouting` is 3.
    internalRouting: 1,
    extst: true,
    extvc: true,
    keepreg: true,
    keepCallerName: true,
    regexpires: REGISTRATION_TTL_S,
    inboundFormat: '',
    displayname: '',
    maxregs: settings.ringotelMaxRegs,
    blfs
  };
}
