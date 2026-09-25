/**
 * Handles `POST /internal/configChanged` (§3.1 "Config propagation"): validates the body,
 * invalidates the config cache, reloads the named Asterisk modules over ARI, and recomputes
 * presence from the new configuration (§10.2 "Presence and BLF").
 */
import type http from 'node:http';

import type { ConfigChangedRequest, ReloadKind } from '@zamfono/shared';

import type { AriClient } from '../ari/client.js';
import type { AsteriskModule } from '../ari/types.js';
import type { ConfigCache } from './snapshot.js';

const HTTP_NO_CONTENT = 204;
const HTTP_BAD_REQUEST = 400;
const HTTP_PAYLOAD_TOO_LARGE = 413;
// `configChanged` bodies are a short list of reload kinds; this only bounds a request from the
// internal network's one client (§3.1), not a size any real body approaches.
const MAX_INTERNAL_BODY_BYTES = 65536;

export const RELOAD_MODULES: Record<ReloadKind, AsteriskModule> = {
  pjsip: 'res_pjsip',
  dialplan: 'pbx_config',
  moh: 'res_musiconhold'
};

export function respondJson(
  response: http.ServerResponse,
  status: number,
  body: unknown
): void {
  response.writeHead(status, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify(body));
}

function readJsonBody(request: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let receivedBytes = 0;
    let tooLarge = false;
    request.on('data', (chunk: Buffer) => {
      receivedBytes += chunk.length;
      if (receivedBytes > MAX_INTERNAL_BODY_BYTES) {
        // Keep draining so 'end' still fires and a response can be written on this connection,
        // but stop buffering: the request is already rejected once it finishes.
        tooLarge = true;
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => {
      if (tooLarge) {
        reject(new Error('request body too large'));
        return;
      }
      const text = Buffer.concat(chunks).toString('utf8');
      if (text === '') {
        resolve(undefined);
        return;
      }
      try {
        resolve(JSON.parse(text) as unknown);
      } catch (error) {
        reject(error instanceof Error ? error : new Error('invalid JSON body'));
      }
    });
    request.on('error', reject);
  });
}

function isConfigChangedRequest(body: unknown): body is ConfigChangedRequest {
  if (typeof body !== 'object' || body === null) {
    return false;
  }
  const { reload } = body as { reload?: unknown };
  return (
    Array.isArray(reload) &&
    reload.every(
      (kind: unknown) =>
        typeof kind === 'string' && Object.hasOwn(RELOAD_MODULES, kind)
    )
  );
}

/** Reads and JSON-parses the request body, reporting a malformed or oversized one. */
async function readConfigChangedBody(
  request: http.IncomingMessage
): Promise<
  { ok: true; body: unknown } | { ok: false; reason: 'malformed' | 'tooLarge' }
> {
  try {
    return { ok: true, body: await readJsonBody(request) };
  } catch (error) {
    const reason =
      error instanceof Error && error.message === 'request body too large'
        ? 'tooLarge'
        : 'malformed';
    return { ok: false, reason };
  }
}

/** `presence.ts`'s `Presence`, as far as a config change needs it; `null` recomputes nothing. */
export type PresenceRefresh = { refreshAll: () => Promise<void> };

export type ConfigChangedDeps = {
  cache: ConfigCache;
  ari: AriClient;
  presence: PresenceRefresh | null;
};

/**
 * Reloads every Asterisk module `api` renders configuration for (§3.1, §9.1), once at boot.
 * Asterisk starts before the first render, so its `#include`s of the generated files resolve to
 * nothing on a fresh stack; and a write `api` made while this process was down had its
 * propagation refused, leaving the rendered files on the volume with Asterisk still on its old
 * view. Either way the configuration on disk is the truth, and this is what makes Asterisk read
 * it. Reloading a module that is already current costs one ARI call and changes nothing. The
 * client runs the reloads one at a time and retries one Asterisk refuses while another runs
 * (`ari/moduleReloader.ts`), so asking for all of them at once is safe.
 */
export async function reloadAllModules(ari: AriClient): Promise<void> {
  await Promise.all(
    Object.values(RELOAD_MODULES).map(module =>
      ari.asterisk.reloadModule(module)
    )
  );
}

export async function handleConfigChanged(
  deps: ConfigChangedDeps,
  request: http.IncomingMessage,
  response: http.ServerResponse
): Promise<void> {
  const parsed = await readConfigChangedBody(request);
  if (!parsed.ok) {
    if (parsed.reason === 'tooLarge') {
      respondJson(response, HTTP_PAYLOAD_TOO_LARGE, {
        message: 'body too large'
      });
      return;
    }
    respondJson(response, HTTP_BAD_REQUEST, { message: 'invalid body' });
    return;
  }
  if (!isConfigChangedRequest(parsed.body)) {
    respondJson(response, HTTP_BAD_REQUEST, { message: 'invalid body' });
    return;
  }
  const { body } = parsed;
  deps.cache.invalidate();
  await Promise.all(
    body.reload.map(kind =>
      deps.ari.asterisk.reloadModule(RELOAD_MODULES[kind])
    )
  );
  // A write `api` made can change a user's presence without any call or registration event:
  // DND set over REST, the last device deleted (§5.7, §10.2). `*90`/`*91` refresh on their own.
  await deps.presence?.refreshAll();
  response.writeHead(HTTP_NO_CONTENT);
  response.end();
}
