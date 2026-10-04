import { attempt } from '../errors.js';
import type { ClientMeta } from './clients.js';

// RFC 8252 §7.3 (loopback IP literals) and §8.3 (`localhost`), as `URL.hostname` spells them.
const LOOPBACK_HOSTS: ReadonlySet<string> = new Set([
  '127.0.0.1',
  '[::1]',
  'localhost'
]);
const HTTP_PROTOCOL = 'http:';
const HTTPS_PROTOCOL = 'https:';

/**
 * `uri` may be registered as a redirect URI (§5.2 "Client registration"): an absolute `https` or
 * `http` URI (OAuth 2.1 §2.3.1), or for a `native` client a private-use scheme, which RFC 8252
 * §7.1 makes a reverse domain name such as `com.example.app:`.
 */
export function redirectUriAcceptable(
  uri: string,
  applicationType: ClientMeta['applicationType']
): boolean {
  const url = URL.parse(uri);
  if (url === null) {
    return false;
  }
  if (url.protocol === HTTPS_PROTOCOL || url.protocol === HTTP_PROTOCOL) {
    return true;
  }
  return applicationType === 'native' && url.protocol.includes('.');
}

/** `uri` parsed as an `http` URI on a loopback host, or `null` for anything else. */
function loopbackUrl(uri: string): URL | null {
  const url = attempt(() => new URL(uri));
  return url?.protocol === HTTP_PROTOCOL && LOOPBACK_HOSTS.has(url.hostname)
    ? url
    : null;
}

/**
 * `uri` is an allowed redirect for `meta` (§5.2 "Client registration"): an exact match, or an
 * `http` loopback URI on any port that equals a registered loopback URI in every other part:
 * host, path and query, and userinfo and fragment, which neither should have. RFC 8252 §7.3:
 * the server "MUST allow any port to be specified at the time of the request for loopback IP
 * redirect URIs"; OAuth 2.1 §2.3.1 says the same, and RFC 8252 §8.3 allows `localhost` too. The
 * rule holds whatever the `application_type`: Claude Code's metadata document names none, so it
 * is a `web` client, and registers `http://localhost/callback` without a port. The host matches
 * as registered: `localhost` never stands for `127.0.0.1`, nor the reverse.
 */
export function redirectUriAllowed(meta: ClientMeta, uri: string): boolean {
  if (meta.redirectUris.includes(uri)) {
    return true;
  }
  const candidate = loopbackUrl(uri);
  if (candidate === null) {
    return false;
  }
  return meta.redirectUris.some(allowed => {
    const allowedUrl = loopbackUrl(allowed);
    if (allowedUrl === null) {
      return false;
    }
    const atRegisteredPort = new URL(candidate);
    atRegisteredPort.port = allowedUrl.port;
    return atRegisteredPort.href === allowedUrl.href;
  });
}
