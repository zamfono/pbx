import type { Db } from '@zamfono/shared';

import { decrypt, type Keyring } from '../secretbox.js';
import type { SettingsRow } from './types.js';

const RINGOTEL_API_URL = 'https://shell.ringotel.co/api';

/**
 * How long one Ringotel RPC may take before it is aborted. A provisioning push runs inside the
 * operation's SQLite write transaction, and SQLite admits one writer at a time, so this bound is
 * also the bound on how long one push blocks every other write.
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
  const apiToken = decrypt(keyring, settings.ringotelApiTokenEnc).toString(
    'utf8'
  );
  return {
    async call<T>(
      method: string,
      params?: Record<string, unknown>
    ): Promise<T> {
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
      if (!response.ok || body.error !== undefined) {
        throw new Error(
          `ringotel: '${method}' failed: ${JSON.stringify(body.error ?? response.status)}`
        );
      }
      return body.result as T;
    }
  };
}
