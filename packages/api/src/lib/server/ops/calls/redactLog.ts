/**
 * The `calls.log` a `user` reads (§10.3 "Call history"): the SIP messages' secrets replaced by a
 * fixed marker, their header names kept so the log stays readable. Admins and owners read it
 * as stored.
 */

const MARKER = '***';

/** An `X-` header (a `sip` target's custom headers, such as an API key), `Authorization` or
 *  `Proxy-Authorization` (a digest response allows an offline guess of the password), with any
 *  folded continuation lines. */
const SECRET_HEADER =
  /^(?<name>x-[^:\s]*|authorization|proxy-authorization)[ \t]*:[^\r\n]*(?:\r?\n[ \t][^\r\n]*)*/gimu;

/** An SDP `a=crypto` line, whose `inline:` parameter is the SRTP master key (SDES). */
const CRYPTO_LINE = /^a=crypto:[^\r\n]*/gimu;

/** One SIP message with its secrets replaced by the marker. */
export function redactSip(raw: string): string {
  return raw
    .replace(SECRET_HEADER, `$<name>: ${MARKER}`)
    .replace(CRYPTO_LINE, `a=crypto:${MARKER}`);
}

/** `log`, newline-delimited JSON, with each SIP line's `raw` redacted; a line that is no JSON
 *  object, which `core` never writes, becomes the marker rather than pass unread. */
export function redactLog(log: string): string {
  return log
    .split('\n')
    .map(line => {
      try {
        const parsed: unknown = JSON.parse(line);
        if (typeof parsed !== 'object' || parsed === null) {
          return MARKER;
        }
        const entry = parsed as Record<string, unknown>;
        return typeof entry.raw === 'string'
          ? JSON.stringify({ ...entry, raw: redactSip(entry.raw) })
          : line;
      } catch {
        return MARKER;
      }
    })
    .join('\n');
}
