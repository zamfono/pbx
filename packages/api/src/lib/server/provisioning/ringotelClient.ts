import pino from 'pino';

import { HTTP_BAD_GATEWAY, isRecord, type Db } from '@zamfono/shared';

import { OpError } from '../ops/types.js';
import { decrypt, type Keyring } from '../secretbox.js';
import type { SettingsRow } from './types.js';

// One line per call: the method, how long it took and whether Ringotel refused it, never the
// parameters, which carry SIP passwords.
const log = pino({ name: 'ringotel' });

/**
 * A call Ringotel answered with an error (§10.4): an operation's caller receives it as a 502
 * carrying Ringotel's own message, not as a bare internal error.
 */
export class RingotelError extends OpError {
  constructor(
    public method: string,
    public ringotelMessage: string
  ) {
    super(HTTP_BAD_GATEWAY, `ringotel: '${method}' failed: ${ringotelMessage}`);
    this.name = 'RingotelError';
  }
}

/**
 * Ringotel's refusal in `body`, or `null` for a result. It reports some refusals as a top-level
 * `error`, and others inside a `result` that holds an `error` of its own and HTTP 200: `createUser`
 * answers `{"result":{"error":"<user> registration failed - Unauthorized","status":-1}}` and
 * creates nothing when its test registration against the PBX fails.
 */
function refusal(
  response: Response,
  body: RingotelRpcResponse<unknown>
): string | null {
  const error =
    body.error ?? (isRecord(body.result) ? body.result.error : undefined);
  if (error === undefined || error === null) {
    return response.ok ? null : `HTTP ${response.status}`;
  }
  if (typeof error === 'string') {
    return error;
  }
  const message = (error as { message?: unknown }).message;
  return typeof message === 'string' ? message : JSON.stringify(error);
}

const RINGOTEL_API_URL = 'https://shell.ringotel.co/api';

/**
 * How long one Ringotel RPC may take before it is aborted. Setup, adoption, `devices.delete`,
 * `devices.setBlf` and a user's deletion call Ringotel inside the operation's SQLite write
 * transaction, and SQLite admits one writer at a time, so this bound is also the bound on how
 * long one such call blocks every other write.
 */
const RINGOTEL_TIMEOUT_MS = 15_000;

export type RingotelClient = {
  call<T = unknown>(
    method: string,
    params?: Record<string, unknown>
  ): Promise<T>;
};

/** What the `ringotel` provider (§10.4) is built from; `now` is overridden in tests. */
export type RingotelProviderDeps = {
  client: RingotelClient;
  db: Db;
  now?: () => string;
};

type RingotelRpcResponse<T> = { result?: T; error?: unknown };

/**
 * `RingotelClient` (§10.4): every call is one `POST` to `RINGOTEL_API_URL` with a
 * `{ method, params }` body and the tenant's Ringotel Admin API key as a Bearer token, decrypted
 * here from `settings.ringotelApiTokenEnc`. Every call is bounded by `timeoutMs`. `fetchImpl`
 * defaults to the global `fetch`; both it and `timeoutMs` are overridden in tests.
 */
export function createRingotelClient(
  settings: Pick<SettingsRow, 'ringotelApiTokenEnc'>,
  keyring: Keyring,
  fetchImpl: typeof fetch = fetch,
  timeoutMs: number = RINGOTEL_TIMEOUT_MS
): RingotelClient {
  if (settings.ringotelApiTokenEnc === null) {
    throw new Error(
      'ringotel: no API token configured (settings.ringotelApiToken)'
    );
  }
  const apiToken = decrypt(
    keyring,
    'settings.ringotelApiTokenEnc',
    settings.ringotelApiTokenEnc
  ).toString('utf8');
  return {
    async call<T>(
      method: string,
      params?: Record<string, unknown>
    ): Promise<T> {
      const started = Date.now();
      const signal = AbortSignal.timeout(timeoutMs);
      const response = await fetchImpl(RINGOTEL_API_URL, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${apiToken}`
        },
        body: JSON.stringify(
          params === undefined ? { method } : { method, params }
        ),
        signal
      }).catch((cause: unknown) => {
        if (signal.aborted) {
          throw new Error(
            `ringotel: '${method}' timed out after ${timeoutMs} ms`,
            { cause }
          );
        }
        throw cause;
      });
      const body = (await response.json()) as RingotelRpcResponse<T>;
      const refused = refusal(response, body);
      log.info(
        { method, ms: Date.now() - started, refused: refused ?? undefined },
        refused === null ? 'ringotel: call answered' : 'ringotel: call refused'
      );
      if (refused !== null) {
        throw new RingotelError(method, refused);
      }
      return body.result as T;
    }
  };
}
