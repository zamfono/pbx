import {
  HTTP_CONFLICT,
  HTTP_SERVICE_UNAVAILABLE,
  type HostStatus
} from '@zamfono/shared';

import { REQUEST_BUDGET_MS, type Agent } from './agent.js';
import { passOnRefusal, UpdaterRefusal } from './errors.js';

/**
 * The host the stack runs on (§6.3 "Host control"), offered only while `HOST_CONTROL` is `true`
 * (`ops/system/_updater.ts`): what the host agent last reported of it, and the requests it
 * carries out there. A request resolves once the agent took it; the agent checks again what is
 * checked here.
 */
export type Host = {
  /** What the host agent last reported. */
  read: () => Promise<HostStatus>;
  /** Has the host agent read the host now, and answers with its report. */
  check: () => Promise<HostStatus>;
  /** Zamfono's unattended upgrades on or off. */
  setUpdates: (enabled: boolean) => Promise<void>;
  reboot: () => Promise<void>;
};

async function reported(agent: Agent): Promise<HostStatus> {
  const host = await agent.host();
  if (host === undefined) {
    throw new UpdaterRefusal(
      HTTP_SERVICE_UNAVAILABLE,
      'the host agent has not reported the host yet: is it installed (setup/agent.sh install), and does .env set HOST_CONTROL=true?'
    );
  }
  return host;
}

export function createHost({ agent }: { agent: Agent }): Host {
  // The check in flight, which every check asked meanwhile shares: the agent answers one at a time.
  let checking: Promise<HostStatus> | undefined;
  return {
    read: async () => reported(agent),
    check: async () => {
      checking ??= agent
        .send({ action: 'report' }, Date.now() + REQUEST_BUDGET_MS)
        .then(async () => reported(agent), passOnRefusal)
        .finally(() => {
          checking = undefined;
        });
      return checking;
    },
    setUpdates: async enabled => {
      const deadline = Date.now() + REQUEST_BUDGET_MS;
      if ((await reported(agent)).updates === null) {
        throw new UpdaterRefusal(
          HTTP_CONFLICT,
          'the host has no apt, so it takes no unattended upgrades from Zamfono'
        );
      }
      await agent
        .send({ action: 'updates', enabled }, deadline)
        .catch(passOnRefusal);
    },
    reboot: async () => {
      const deadline = Date.now() + REQUEST_BUDGET_MS;
      if (agent.state().state === 'running') {
        throw new UpdaterRefusal(HTTP_CONFLICT, 'an update is running');
      }
      const { rebootRefused } = await reported(agent);
      if (rebootRefused !== undefined) {
        throw new UpdaterRefusal(HTTP_CONFLICT, rebootRefused);
      }
      await agent.send({ action: 'reboot' }, deadline).catch(passOnRefusal);
    }
  };
}
