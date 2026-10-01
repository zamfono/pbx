/**
 * Why a webhook delivery failed (§10.6 "Webhooks"), as one short reason a hook's failure is
 * logged and deduplicated on and `webhooks.list` shows: the HTTP status of a response that was
 * not 2xx, or the class of error of a request that got none, a timeout, a DNS lookup, TLS or the
 * connection, and a secret that cannot be decrypted.
 */

/** The reason of a delivery dropped because its hook's secret cannot be decrypted. */
export const SECRET_UNREADABLE = 'secret unreadable — set a new secret';

// The `code`s Node's DNS lookup, its TLS layer and its sockets fail a request with.
const DNS_CODES = new Set(['ENOTFOUND', 'EAI_AGAIN', 'EAI_FAIL', 'EAI_NONAME']);
const TLS_CODE =
  /^(?:ERR_TLS_|ERR_SSL_|CERT_|UNABLE_TO_|DEPTH_ZERO_|SELF_SIGNED_)/u;
const SOCKET_REASONS: Record<string, string> = {
  ECONNREFUSED: 'connection refused',
  ECONNRESET: 'connection reset',
  EHOSTUNREACH: 'host unreachable',
  ENETUNREACH: 'network unreachable'
};

/** The `code` of `error` or of the error it wraps, as `fetch` wraps a socket's. */
function errorCode(error: unknown): string | undefined {
  for (let current = error; current instanceof Error; current = current.cause) {
    const { code } = current as { code?: unknown };
    if (typeof code === 'string') {
      return code;
    }
  }
  return undefined;
}

/** A failed response's reason: its HTTP status. */
export function httpReason(status: number): string {
  return `HTTP ${String(status)}`;
}

/** Why a request that never got a response failed: a timeout, DNS, TLS, the connection. */
export function errorReason(error: unknown): string {
  if (
    error instanceof Error &&
    (error.name === 'TimeoutError' || error.name === 'AbortError')
  ) {
    return 'timeout';
  }
  const code = errorCode(error);
  if (code === undefined) {
    return 'network error';
  }
  if (DNS_CODES.has(code)) {
    return 'DNS lookup failed';
  }
  if (TLS_CODE.test(code)) {
    return `TLS error ${code}`;
  }
  return SOCKET_REASONS[code] ?? `network error ${code}`;
}
