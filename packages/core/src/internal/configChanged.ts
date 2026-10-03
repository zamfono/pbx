/**
 * Handles `POST /internal/configChanged` (§3.1 "Config propagation"): validates the body,
 * invalidates the config cache, reloads the named Asterisk modules over ARI, and recomputes
 * presence (§10.2 "Presence and BLF") and the `unmonitored` trunk statuses (§9.4 "Provisioning
 * and status") from the new configuration.
 */
import type http from 'node:http';

import {
  HTTP_NO_CONTENT,
  isRecord,
  type ConfigChangedRequest,
  type ReloadKind
} from '@zamfono/shared';

import type { AriClient } from '../ari/client.js';
import type { AsteriskModule } from '../ari/types.js';
import { readJsonBody, respondInvalidBody } from './http.js';
import type { ConfigCache } from './snapshot.js';

const RELOAD_MODULES: Record<ReloadKind, AsteriskModule> = {
  pjsip: 'res_pjsip',
  dialplan: 'pbx_config',
  moh: 'res_musiconhold'
};

function isConfigChangedRequest(body: unknown): body is ConfigChangedRequest {
  return (
    isRecord(body) &&
    Array.isArray(body.reload) &&
    body.reload.every(
      (kind: unknown) =>
        typeof kind === 'string' && Object.hasOwn(RELOAD_MODULES, kind)
    )
  );
}

/** `presence.ts`'s `Presence`, as far as a config change needs it. */
export type PresenceRefresh = { refreshAll: () => Promise<void> };

/** `trunkState.ts`'s `TrunkState`, as far as a config change needs it. */
export type TrunkMonitoringRefresh = { refreshMonitoring: () => Promise<void> };

type ConfigChangedDeps = {
  cache: ConfigCache;
  ari: AriClient;
  presence: PresenceRefresh;
  trunks: TrunkMonitoringRefresh;
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
  response: http.ServerResponse,
  request: http.IncomingMessage
): Promise<void> {
  const parsed = await readJsonBody(request, response);
  if (parsed === null) {
    return;
  }
  const { body } = parsed;
  if (!isConfigChangedRequest(body)) {
    respondInvalidBody(response);
    return;
  }
  deps.cache.invalidate();
  await Promise.all(
    body.reload.map(kind =>
      deps.ari.asterisk.reloadModule(RELOAD_MODULES[kind])
    )
  );
  // A write `api` made can change a user's presence without any call or registration event:
  // DND set over REST, the last device deleted (§5.7, §10.2). `*90`/`*91` refresh on their own.
  await deps.presence.refreshAll();
  // A trunk's `qualify` switched either way (§9.4 "Provisioning and status").
  await deps.trunks.refreshMonitoring();
  response.writeHead(HTTP_NO_CONTENT);
  response.end();
}
