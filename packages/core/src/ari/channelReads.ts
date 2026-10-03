/**
 * The read-only channel query whose "absent" answer is a value rather than an error: a channel
 * variable that is not set (§7 level `sip`, reading `CHANNEL(pjsip,call-id)`). It takes the
 * client's own JSON request function so it needs none of the client's internals.
 */
import { HTTP_INTERNAL_SERVER_ERROR, HTTP_NOT_FOUND } from '@zamfono/shared';

import { AriError } from './types.js';

// Asterisk's answers that mean "no value": 404 for an unset variable and for an unknown channel
// alike, 500 ("Unable to read provided function") for a dialplan function with nothing to read,
// such as `PJSIP_HEADER(read,Privacy)` of a request without that header.
const NO_VALUE_STATUSES: ReadonlySet<number> = new Set([
  HTTP_NOT_FOUND,
  HTTP_INTERNAL_SERVER_ERROR
]);

type JsonRequest = <T>(method: string, path: string) => Promise<T>;

/**
 * `GET /channels/{id}/variable`, `null` when there is no value (`NO_VALUE_STATUSES`); every other
 * failure, such as refused credentials or an unreachable Asterisk, is the caller's.
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
  } catch (error) {
    if (error instanceof AriError && NO_VALUE_STATUSES.has(error.status)) {
      return null;
    }
    throw error;
  }
}
