import { validateFeatureCodes, type FeatureCodes } from '@zamfono/shared';

import type { SettingsRow } from './types.js';

const CODEC_FRAME_MS = 20;

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
  // `internal` and `displayname` carry no provision-key documentation in docs/ringotel.yaml
  // (§10.4): sent as the yaml examples show them, unconfirmed against a live branch.
  internal: boolean;
  displayname: string;
  // A Ringotel user registers up to this many times (§10.4); moves with `settings.ringotelMaxRegs`.
  maxregs: number;
  // The tenant-wide colleague presence panel (§10.4 "Colleague presence"), one entry per
  // extension; every whole-object write carries it so a codec or maxregs change never wipes it.
  blfs: { number: string; title: string }[];
};

/**
 * The Ringotel branch `provision` object (§10.4 "Branch provision profile"), pushed whole at
 * setup and on every `updateBranch` push so the two sides never drift. `blfs` is the caller's
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
    // Candidates for "internal calls pass through the PBX" and "the core's caller-ID name wins
    // over app-local contacts" (§10.4); the yaml examples' own values, unconfirmed against a
    // live branch.
    internal: false,
    displayname: '',
    maxregs: settings.ringotelMaxRegs,
    blfs
  };
}
