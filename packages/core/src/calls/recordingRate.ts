/**
 * The sample rate of one recorded participation (§10.2 "Recording semantics", "Sample rate"):
 * 16 kHz when at least one leg of the bridge it records runs a wideband codec, 8 kHz otherwise.
 * Its own module so `recording.ts`, which tracks the participations, stays one responsibility.
 */
import type { AriClient } from '../ari/client.js';
import type { Logger } from '../ari/types.js';

/** ARI `record` formats: Asterisk's 8 kHz and 16 kHz signed-linear WAV, and the extension of
 * the file each writes. */
export type RecordFormat = 'wav' | 'wav16';

// The codec a PJSIP channel negotiated. `audioreadformat` is no use here: once the channel is in
// a mixing bridge it reads the bridge's own signed linear (`slin16` for every member of a bridge
// holding one G.722 leg, even a G.711 one), while the native format stays the negotiated codec,
// written `(g722)` or, for several, `(g722|alaw)`.
const NATIVE_FORMAT_VARIABLE = 'CHANNEL(audionativeformat)';
const WIDEBAND_CODECS = new Set([
  'opus',
  'g722',
  'amrwb',
  'siren7',
  'siren14',
  'speex16',
  'speex32',
  'silk16',
  'silk24'
]);
// Signed linear at 16 kHz or above: `slin16`, `slin24`, … `slin192` (plain `slin` is 8 kHz).
const WIDEBAND_SLIN = /^slin(?:1[6-9]|[2-9]\d|\d{3})$/u;

function isWidebandFormat(nativeFormat: string | null): boolean {
  if (nativeFormat === null) {
    return false;
  }
  return nativeFormat
    .replaceAll(/[()]/gu, '')
    .split('|')
    .some(codec => WIDEBAND_CODECS.has(codec) || WIDEBAND_SLIN.test(codec));
}

/** The recorded channel and every other leg of the bridge it is in (§10.2 "at least one leg of
 * the bridge it records"). */
async function bridgedChannels(
  ari: AriClient,
  channelId: string
): Promise<string[]> {
  const bridges = await ari.bridges.list();
  const bridge = bridges.find(row => row.channels.includes(channelId));
  return bridge?.channels ?? [channelId];
}

/**
 * The format `channelId`'s snoop pair records in, decided as its participation starts. Best
 * effort (§10.2): a lookup that fails records at 8 kHz, logged at debug, and never stops the
 * recording.
 */
export async function recordFormatFor(
  ari: AriClient,
  channelId: string,
  log: Logger
): Promise<RecordFormat> {
  try {
    const channels = await bridgedChannels(ari, channelId);
    const formats = await Promise.all(
      channels.map(id => ari.channels.getVariable(id, NATIVE_FORMAT_VARIABLE))
    );
    return formats.some(isWidebandFormat) ? 'wav16' : 'wav';
  } catch (error) {
    log.debug(
      { error, channelId },
      'recording codec lookup failed; recording at 8 kHz'
    );
    return 'wav';
  }
}
