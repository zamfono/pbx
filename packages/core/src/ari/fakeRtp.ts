/**
 * A realistic ARI `RTPstat` body, for the fake ARI server and the tests that stand in for
 * `GET /channels/{id}/rtp_statistics` (§7 level `qos`). The default is what Asterisk 22 answers
 * for a leg some twenty seconds into a G.711 call with RTCP flowing both ways: counts as integers,
 * jitter and round trip in seconds, and the fields nothing reads alongside the ones the summary
 * does, so a mapping that picks the wrong field meets the same shape it would on a real stack.
 */
import type { RtpStatistics } from './types.js';

const DEFAULT_RTP_STATISTICS = {
  txcount: 1000,
  rxcount: 990,
  txjitter: 0.0021,
  rxjitter: 0.0034,
  txploss: 5,
  rxploss: 10,
  rtt: 0.042,
  maxrtt: 0.051,
  minrtt: 0.038,
  normdevrtt: 0.043,
  stdevrtt: 0.004,
  // eslint-disable-next-line camelcase -- ARI's own field names, down to the end of the object
  local_maxjitter: 0.004,
  // eslint-disable-next-line camelcase
  local_minjitter: 0.001,
  // eslint-disable-next-line camelcase
  remote_maxjitter: 0.006,
  // eslint-disable-next-line camelcase
  remote_minjitter: 0.001,
  // eslint-disable-next-line camelcase
  local_ssrc: 3_581_287_122,
  // eslint-disable-next-line camelcase
  remote_ssrc: 1_203_774_560,
  txoctetcount: 160_000,
  rxoctetcount: 158_400
};

const HTTP_OK = 200;
const HTTP_NOT_FOUND = 404;

/** An `RTPstat` body: the default above with `overrides` applied. */
export function fakeRtpStatistics(
  overrides: Partial<RtpStatistics> = {}
): RtpStatistics {
  return { ...DEFAULT_RTP_STATISTICS, ...overrides };
}

/** The fake's answer to `GET /channels/{id}/rtp_statistics`: `id`'s entry in `stats`, the default
 * body for a channel not listed, and 404 for one listed as `null`, as Asterisk answers for a
 * channel without an RTP instance (a Local channel, or one before its media is negotiated). */
export function readRtpStatistics(
  stats: ReadonlyMap<string, RtpStatistics | null>,
  id: string
): { status: number; body: unknown } {
  const stat = stats.has(id) ? stats.get(id) : fakeRtpStatistics();
  return stat === null || stat === undefined
    ? {
        status: HTTP_NOT_FOUND,
        body: { message: 'Channel RTP statistics not found' }
      }
    : { status: HTTP_OK, body: stat };
}
