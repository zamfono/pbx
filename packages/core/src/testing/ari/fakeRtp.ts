/**
 * A realistic `RTPAUDIOQOS` channel variable (§7 level `qos`), for the fake ARI server and the
 * tests that stand in for the one Asterisk sets on a channel as it hangs up. The default is what
 * Asterisk 22 writes for a leg some twenty seconds into a G.711 call with RTCP flowing both ways,
 * in `ast_rtp_instance_get_quality`'s own format: counts as integers, jitter and round trip in
 * seconds with six decimals, and the fields nothing reads (SSRCs, MES) alongside the ones the
 * summary does, so a parser that picks the wrong field meets the string it would on a real stack.
 */
import type { RtpQos } from '#src/qosFigures.js';

const DEFAULT_RTP_QOS: RtpQos = {
  txcount: 1000,
  rxcount: 990,
  txjitter: 0.0021,
  rxjitter: 0.0034,
  txploss: 5,
  rxploss: 10,
  rtt: 0.042
};

const LOCAL_SSRC = 3_581_287_122;
const REMOTE_SSRC = 1_203_774_560;
const MES = 88.087_887;
const DECIMALS = 6;

function seconds(value: number): string {
  return value.toFixed(DECIMALS);
}

/** An `RTPAUDIOQOS` value: the default above with `overrides` applied; a count overridden with
 * null is left out, as a variable that names none. */
export function fakeRtpAudioQos(overrides: Partial<RtpQos> = {}): string {
  const stat = { ...DEFAULT_RTP_QOS, ...overrides };
  return [
    `ssrc=${LOCAL_SSRC}`,
    `themssrc=${REMOTE_SSRC}`,
    `lp=${stat.rxploss}`,
    `rxjitter=${seconds(stat.rxjitter)}`,
    stat.rxcount === null ? null : `rxcount=${stat.rxcount}`,
    `txjitter=${seconds(stat.txjitter)}`,
    stat.txcount === null ? null : `txcount=${stat.txcount}`,
    `rlp=${stat.txploss}`,
    `rtt=${seconds(stat.rtt)}`,
    `rxmes=${seconds(MES)}`,
    `txmes=${seconds(MES)}`
  ]
    .filter(pair => pair !== null)
    .join(';');
}

// The events Asterisk publishes after it set the variable: chan_pjsip sets it as the session
// ends (a BYE) or as the channel is hung up, and ARI's own `DELETE /channels/{id}` before its
// hangup request, so the channel's `ChannelHangupRequest` and everything after carry it.
const ENDING_EVENTS: ReadonlySet<string> = new Set([
  'ChannelHangupRequest',
  'StasisEnd',
  'ChannelDestroyed'
]);

/**
 * `channel.channelvars` of an event the fake emits, as ari.conf's `channelvars = RTPAUDIOQOS`
 * makes Asterisk fill it: "" until the channel ends, then `id`'s entry in `stats` (a statistics
 * record, or `null` for a channel without an RTP instance, whose variable stays ""), the default
 * value for a channel not listed.
 */
export function fakeChannelVars(
  stats: ReadonlyMap<string, Partial<RtpQos> | null>,
  eventType: string,
  id: string
): Record<string, string> {
  if (!ENDING_EVENTS.has(eventType)) {
    return { RTPAUDIOQOS: '' };
  }
  const stat = stats.has(id) ? stats.get(id) : {};
  return {
    RTPAUDIOQOS:
      stat === null || stat === undefined ? '' : fakeRtpAudioQos(stat)
  };
}
