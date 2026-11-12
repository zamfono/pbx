/**
 * `api`'s updater (§6.3 "Updates" and "Host control", `lib/server/updater/`): the GitHub lookup,
 * the verdict on an update, and the requests it leaves the host agent in the stack directory's
 * `.update`, which compose.yaml mounts at `UPDATE_DIR`.
 */
import * as env from '$app/env/private';

import type {
  HostStatus,
  UpdateRequester,
  UpdaterStatus,
  UpdateState
} from '@zamfono/shared';

import { createAgent } from '#lib/server/updater/agent.js';
import { UpdaterRefusal } from '#lib/server/updater/errors.js';
import { createReleases } from '#lib/server/updater/releases.js';
import { createUpdater, type Updater } from '#lib/server/updater/service.js';
import { createStack } from '#lib/server/updater/stack.js';

/** A refusal with its status, message and, for a spent GitHub rate limit, `Retry-After` in
 * seconds, which the operations pass on. */
export { UpdaterRefusal };

export type UpdaterClient = {
  /** The update status; `fresh` asks GitHub now. */
  status: (fresh?: boolean) => Promise<UpdaterStatus>;
  /** The latest release, or `version`, a breaking one only with the owner's `breaking`;
   * resolves once the host agent began. */
  update: (
    version: string | undefined,
    requester?: UpdateRequester
  ) => Promise<UpdateState>;
};

const MAX_BY_BYTES = 200;

/**
 * An owner's name as the host agent takes it for a run's record: no control characters, at most
 * 200 bytes of UTF-8, cut at a character.
 */
export function ownerName(name: string): string {
  let out = '';
  for (const char of name.replace(/\p{Cc}/gu, ' ')) {
    if (Buffer.byteLength(out + char) > MAX_BY_BYTES) {
      break;
    }
    out += char;
  }
  return out.trim() || 'an owner';
}

// One for the process, the GitHub cache and the queue of requests to the agent being its; a test
// that points UPDATE_DIR elsewhere gets its own.
let shared: { dir: string; updater: Updater } | undefined;

function updater(): Updater {
  const dir = env.UPDATE_DIR;
  if (shared?.dir !== dir) {
    const stack = createStack(dir);
    shared = {
      dir,
      updater: createUpdater({
        releases: createReleases(),
        agent: createAgent(dir),
        currentVersion: stack.currentVersion,
        checkUpdate: stack.checkUpdate
      })
    };
  }
  return shared.updater;
}

/** The client, or `undefined` while `.env` leaves `UPDATER_TOKEN` empty, which turns updates
 * through the API off. */
export function updaterClient(): UpdaterClient | undefined {
  if (env.UPDATER_TOKEN === undefined) {
    return undefined;
  }
  // The commit api was built from, which an edge stack's newest build is newer than when they
  // differ (§6.3 "Updates").
  const revision = env.ZAMFONO_REVISION ?? '';
  return {
    status: async fresh => updater().status(fresh === true, revision),
    update: async (version, requester) =>
      updater().update({
        ...(version === undefined ? {} : { version }),
        ...requester
      })
  };
}

/** The host the stack runs on (§6.3 "Host control"). */
export type HostClient = {
  /** What the host agent last reported. */
  read: () => Promise<HostStatus>;
  /** Has the host agent read the host now, and answers with its report. */
  check: () => Promise<HostStatus>;
  /** Zamfono's unattended upgrades on or off; resolves once the host agent took the request,
   * which it carries out after. */
  setUpdates: (enabled: boolean) => Promise<void>;
  /** Resolves once the host agent took the request. */
  reboot: () => Promise<void>;
};

/**
 * The host client, or `undefined` unless `.env` sets `HOST_CONTROL=true`: without it nothing of
 * the host is shown or offered.
 */
export function hostClient(): HostClient | undefined {
  return env.HOST_CONTROL ? updater().host : undefined;
}
