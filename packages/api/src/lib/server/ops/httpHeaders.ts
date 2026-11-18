/**
 * A request's custom headers in their row (§10.6 "Request headers", §11.2): written from a
 * write's `headers`, a secret one's value encrypted (§5.4) and kept when the write leaves it
 * out, and read back with their values for the request that sends them.
 */
import {
  decodeStoredHeaders,
  HTTP_HEADERS_MAX_BYTES,
  HTTP_UNPROCESSABLE_CONTENT,
  httpHeadersSize,
  wireHeaders,
  type HttpHeader,
  type HttpHeaderInput,
  type StoredHttpHeader
} from '@zamfono/shared';

import { decrypt, encrypt, type Keyring, type Purpose } from '../secretbox.js';
import { recordChange } from './audit.js';
import { OpError, type Context } from './types.js';

/** A row's two header columns. */
export type HeaderColumns = {
  headersJson: string;
  secretHeadersEnc: Buffer | null;
};

/** No headers. */
export const NO_HEADERS: HeaderColumns = {
  headersJson: '[]',
  secretHeadersEnc: null
};

/** The secret headers' values of `columns`, by lower-case name. */
function secretValues(
  kr: Keyring,
  purpose: Purpose,
  columns: HeaderColumns
): Record<string, string> {
  return columns.secretHeadersEnc === null
    ? {}
    : (JSON.parse(
        decrypt(kr, purpose, columns.secretHeadersEnc).toString('utf8')
      ) as Record<string, string>);
}

/** `columns`' headers with their values, in order, as the request sends them; throws when the
 * secret ones cannot be decrypted (§5.4). */
export function readHeaders(
  kr: Keyring,
  purpose: Purpose,
  columns: HeaderColumns
): HttpHeader[] {
  const secrets = secretValues(kr, purpose, columns);
  return decodeStoredHeaders(columns.headersJson).map(header => ({
    name: header.name,
    value:
      'value' in header
        ? header.value
        : (secrets[header.name.toLowerCase()] ?? '')
  }));
}

/**
 * The columns `headers` are stored as. A secret header written without its value keeps the one
 * `before` holds under its name, and is refused with 422 where it holds none; so are headers
 * larger than `HTTP_HEADERS_MAX_BYTES` as written.
 */
export function storeHeaders(
  kr: Keyring,
  purpose: Purpose,
  headers: readonly HttpHeaderInput[],
  before: HeaderColumns = NO_HEADERS
): HeaderColumns {
  const kept = headers.some(
    header => header.secret && header.value === undefined
  )
    ? secretValues(kr, purpose, before)
    : {};
  const secrets: Record<string, string> = {};
  const stored: StoredHttpHeader[] = [];
  const full: HttpHeader[] = [];
  for (const { name, value, secret } of headers) {
    const resolved = value ?? kept[name.toLowerCase()];
    if (resolved === undefined) {
      throw new OpError(
        HTTP_UNPROCESSABLE_CONTENT,
        `header ${name} has no stored value to keep; give its value`
      );
    }
    full.push({ name, value: resolved });
    if (secret) {
      secrets[name.toLowerCase()] = resolved;
      stored.push({ name, secret: true });
    } else {
      stored.push({ name, value: resolved });
    }
  }
  const size = httpHeadersSize(full);
  if (size > HTTP_HEADERS_MAX_BYTES) {
    throw new OpError(
      HTTP_UNPROCESSABLE_CONTENT,
      `headers take ${String(size)} bytes, more than ${String(HTTP_HEADERS_MAX_BYTES)}`
    );
  }
  return {
    headersJson: JSON.stringify(stored),
    secretHeadersEnc:
      Object.keys(secrets).length === 0
        ? null
        : encrypt(kr, purpose, JSON.stringify(secrets))
  };
}

/** Records a change of headers on `ctx`'s audit entry, as a read shows them: a secret header by
 * its name alone. A change of headers with a secret one among them, before or after, cannot be
 * undone, since the entry holds no value to restore (§5.8). */
export function recordHeaderChange(
  ctx: Context,
  beforeJson: string,
  afterJson: string
): void {
  const from = wireHeaders(beforeJson);
  const to = wireHeaders(afterJson);
  const secret = [...from, ...to].some(header => header.secret);
  if (JSON.stringify(from) === JSON.stringify(to) && !secret) {
    return;
  }
  recordChange(ctx, { field: 'headers', from, to });
  if (secret) {
    ctx.effects.undoable = false;
  }
}
