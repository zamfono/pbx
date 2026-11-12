import type { HostStatus } from '@zamfono/shared';

import { REQUEST_BUDGET_MS } from './agent.js';
import { HttpError } from './errors.js';
import { passOnRefusal, type ServerDeps } from './server.js';

/**
 * The updater's host routes (§6.3 "Host control"), only while `HOST_CONTROL` is `true`: what the
 * host agent last reported of the host, and the requests it carries out there. A request is
 * answered once the agent took it; it checks again what the updater checked.
 */
const HTTP_OK = 200;
const HTTP_ACCEPTED = 202;
const HTTP_BAD_REQUEST = 400;
const HTTP_NOT_FOUND = 404;
const HTTP_CONFLICT = 409;
const HTTP_SERVICE_UNAVAILABLE = 503;

async function reported(deps: ServerDeps): Promise<HostStatus> {
  const host = await deps.agent.host();
  if (host === undefined) {
    throw new HttpError(
      HTTP_SERVICE_UNAVAILABLE,
      'the host agent has not reported the host yet: is it installed (setup/agent.sh install), and does .env set HOST_CONTROL=true?'
    );
  }
  return host;
}

// The check in flight, which every check asked meanwhile shares: the agent answers one at a time.
let checking: Promise<HostStatus> | undefined;

/** `POST /host/check`: has the agent read the host now, and answers with its report. */
async function check(deps: ServerDeps, started: number): Promise<HostStatus> {
  checking ??= deps.agent
    .send({ action: 'report' }, started + REQUEST_BUDGET_MS)
    .then(async () => reported(deps), passOnRefusal)
    .finally(() => {
      checking = undefined;
    });
  return checking;
}

/** `GET /host`, `POST /host/check`, `POST /host/updates` (`{ enabled }`) and `POST /host/reboot`. */
export async function hostRoute(
  deps: ServerDeps,
  key: string,
  body: () => Promise<unknown>,
  started: number
): Promise<[number, unknown]> {
  const deadline = started + REQUEST_BUDGET_MS;
  if (!deps.hostControl) {
    throw new HttpError(HTTP_NOT_FOUND, 'HOST_CONTROL is not true in .env');
  }
  if (key === 'GET /host') {
    return [HTTP_OK, await reported(deps)];
  }
  if (key === 'POST /host/check') {
    return [HTTP_OK, await check(deps, started)];
  }
  if (key === 'POST /host/updates') {
    const { enabled } = (await body()) as { enabled?: unknown };
    if (typeof enabled !== 'boolean') {
      throw new HttpError(HTTP_BAD_REQUEST, 'enabled must be a boolean');
    }
    if ((await reported(deps)).updates === null) {
      throw new HttpError(
        HTTP_CONFLICT,
        'the host has no apt, so it takes no unattended upgrades from Zamfono'
      );
    }
    await deps.agent
      .send({ action: 'updates', enabled }, deadline)
      .catch(passOnRefusal);
    return [HTTP_ACCEPTED, {}];
  }
  if (key === 'POST /host/reboot') {
    if (deps.agent.state().state === 'running') {
      throw new HttpError(HTTP_CONFLICT, 'an update is running');
    }
    const { rebootRefused } = await reported(deps);
    if (rebootRefused !== undefined) {
      throw new HttpError(HTTP_CONFLICT, rebootRefused);
    }
    await deps.agent.send({ action: 'reboot' }, deadline).catch(passOnRefusal);
    return [HTTP_ACCEPTED, {}];
  }
  throw new HttpError(HTTP_NOT_FOUND, `no route ${key}`);
}
