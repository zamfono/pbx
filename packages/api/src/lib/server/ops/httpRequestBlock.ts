/**
 * The HTTP request block in its row (§10.6 "HTTP requests", §11.2): the columns an after-call
 * request and a call flow's HTTP request share, written from a write's fields and read back
 * with their secrets for the request that is sent.
 */
import {
  wireHeaders,
  type HttpContentType,
  type HttpHeaderInput,
  type HttpHeaderWire,
  type HttpMethod,
  type StoredRequest
} from '@zamfono/shared';

import { decrypt, encrypt, type Keyring, type Purpose } from '../secretbox.js';
import {
  readHeaders,
  storeHeaders,
  type HeaderColumns
} from './httpHeaders.js';

/** The block's columns but its signing secret, which a table may or may not require. */
export type BlockColumns = HeaderColumns & {
  method: HttpMethod;
  url: string;
  body: string | null;
  contentType: HttpContentType | null;
};

/** A block as a write gives it. */
export type BlockInput = {
  method: HttpMethod;
  url: string;
  headers: HttpHeaderInput[];
  body: string | null;
  contentType: HttpContentType | null;
};

/** The `<table>.secretHeadersEnc` and `<table>.secretEnc` a table's block encrypts under. */
export type BlockPurposes = { headers: Purpose; secret: Purpose };

/** The columns `input` is stored as, a secret header left out kept from `before`. */
export function storeBlock(
  kr: Keyring,
  purposes: BlockPurposes,
  input: BlockInput,
  before?: HeaderColumns
): BlockColumns {
  return {
    method: input.method,
    url: input.url,
    body: input.body,
    contentType: input.contentType,
    ...storeHeaders(kr, purposes.headers, input.headers, before)
  };
}

/** The signing secret's column: `secret` encrypted, else the one `before` holds. */
export function storeSecret(
  kr: Keyring,
  purposes: BlockPurposes,
  secret: string | undefined,
  before: Buffer | null
): Buffer | null {
  return secret === undefined ? before : encrypt(kr, purposes.secret, secret);
}

/** A block's fields as a read returns them. */
export function blockWire(row: BlockColumns): {
  method: HttpMethod;
  url: string;
  headers: HttpHeaderWire[];
  body: string | null;
  contentType: HttpContentType | null;
} {
  return {
    method: row.method,
    url: row.url,
    headers: wireHeaders(row.headersJson),
    body: row.body,
    contentType: row.contentType
  };
}

/** `row`'s block with its secrets, as one request is rendered from it; throws when they cannot
 * be decrypted (§5.4). */
export function readBlock(
  kr: Keyring,
  purposes: BlockPurposes,
  row: BlockColumns & { secretEnc: Buffer | null }
): StoredRequest {
  return {
    method: row.method,
    url: row.url,
    body: row.body,
    contentType: row.contentType,
    headers: readHeaders(kr, purposes.headers, row),
    secret:
      row.secretEnc === null
        ? null
        : decrypt(kr, purposes.secret, row.secretEnc).toString('utf8')
  };
}
