/**
 * The two read-only channel queries whose "absent" answer is a value rather than an error: RTP
 * statistics for a channel that has none yet (§7 level `qos`), and a channel variable that is not
 * set (§7 level `sip`, reading `CHANNEL(pjsip,call-id)`). Both take the client's own JSON request
 * function so neither needs the client's internals.
 */
import { AriError, type RtpStatistics } from './types.js';

const HTTP_NOT_FOUND = 404;

export type JsonRequest = <T>(method: string, path: string) => Promise<T>;

/** `GET /channels/{id}/rtp_statistics`, `null` while the channel carries no RTP yet. */
export async function channelRtpStatistics(
  request: JsonRequest,
  id: string
): Promise<RtpStatistics | null> {
  try {
    return await request<RtpStatistics>('GET', `channels/${id}/rtp_statistics`);
  } catch (error) {
    if (error instanceof AriError && error.status === HTTP_NOT_FOUND) {
      return null;
    }
    throw error;
  }
}

/**
 * `GET /channels/{id}/variable`, `null` when the variable is unset. Asterisk answers 404 for an
 * unset variable and for an unknown channel alike, and both mean "no value" to every caller.
 */
export async function channelVariable(
  request: JsonRequest,
  id: string,
  name: string
): Promise<string | null> {
  try {
    const body = await request<{ value?: string }>(
      'GET',
      `channels/${id}/variable?variable=${encodeURIComponent(name)}`
    );
    return body.value ?? null;
  } catch {
    return null;
  }
}
