import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  link,
  readFile,
  rename,
  rm,
  stat,
  unlink,
  writeFile
} from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

import type { HostStatus, RunRequester, UpdateState } from '@zamfono/shared';

import { settle } from './record.js';

/**
 * `api`'s side of the host agent (deploy/setup/agent.sh, §6.3 "Updates" and "Host control"),
 * which carries out on the host what `api` may only ask for: it leaves one request at a time in
 * `.update/requests/request`, the one place of the stack directory it may write, and reads what
 * the agent writes back in `.update/`, which it mounts read-only: `agent`, when it last ran,
 * `stack.json`, what the stack directory runs, `state.json`, the last update's record, and with
 * `HOST_CONTROL` `host.json`.
 */
export type AgentRequest =
  | {
      action: 'update';
      version: string;
      breaking: boolean;
      requester: RunRequester;
    }
  | { action: 'reboot' }
  | { action: 'report' }
  | { action: 'updates'; enabled: boolean };

export type Agent = {
  /** Whether a host agent of this release has run for the stack directory: one that reports
   * what it runs. */
  present: () => Promise<boolean>;
  /** The last update's record, a `running` one that cannot still be running marked failed. */
  state: () => UpdateState;
  /** What the agent last reported of the host; `undefined` before it did. */
  host: () => Promise<HostStatus | undefined>;
  /** Leaves `request` for the agent and resolves once the agent answered that it carries it out,
   * by `deadline` (ms since the epoch); an `AgentRefusal` otherwise, with the agent's own reason
   * where it refused. A request not taken by then is taken back, so nothing happens after the
   * caller was told it did not. */
  send: (request: AgentRequest, deadline: number) => Promise<void>;
};

/** Why a request was not carried out: one still waits, the agent did not take or answer it, or
 * it refused it. */
export class AgentRefusal extends Error {
  constructor(
    readonly reason: 'pending' | 'notTaken' | 'refused',
    message: string
  ) {
    super(message);
  }
}

/**
 * How long a request may take from the operation that asked for it until the agent answered it:
 * the operation answers within 10 s, so nothing it asks of the host happens after it has given
 * up and reported a failure. The host agent refuses a request older than 10 s for the same
 * reason (`deploy/setup/agent.sh`).
 */
export const REQUEST_BUDGET_MS = 8000;
/** The part of the budget kept for the agent's answer, which follows its take at once. */
const ANSWER_RESERVE_MS = 1000;
const POLL_MS = 200;

/** `request` as the agent reads it: one `key=value` a line, every value checked by the caller. */
function requestText(id: string, request: AgentRequest): string {
  let fields: Record<string, string> = { id, action: request.action };
  if (request.action === 'update') {
    fields = {
      ...fields,
      version: request.version,
      breaking: String(request.breaking),
      trigger: request.requester.trigger,
      ...(request.requester.trigger === 'manual'
        ? { by: request.requester.by }
        : {})
    };
  } else if (request.action === 'updates') {
    fields = { ...fields, enabled: String(request.enabled) };
  }
  return Object.entries(fields)
    .map(([key, value]) => `${key}=${value}\n`)
    .join('');
}

/** The agent's answer to a request, `.update/result`. */
type Answer = { id: string; ok: boolean; reason?: string };

async function readAnswer(file: string): Promise<Answer | undefined> {
  try {
    return JSON.parse(await readFile(file, 'utf8')) as Answer;
  } catch {
    return undefined;
  }
}

async function exists(file: string): Promise<boolean> {
  return stat(file).then(
    () => true,
    () => false
  );
}

/** Polls until `done` holds or `ms` passed by `now`; whether it held. */
async function waitFor(
  done: () => Promise<boolean>,
  ms: number,
  now: () => number
): Promise<boolean> {
  const deadline = now() + ms;
  for (;;) {
    // eslint-disable-next-line no-await-in-loop -- polling the agent, one look at a time
    if (await done()) {
      return true;
    }
    if (now() >= deadline) {
      return false;
    }
    // eslint-disable-next-line no-await-in-loop -- see above
    await sleep(POLL_MS);
  }
}

/**
 * Takes the request back unless the agent took it meanwhile, by renaming it away, which only one
 * of the two can do; whether it was still there.
 */
async function withdraw(requestFile: string): Promise<boolean> {
  const away = path.join(path.dirname(requestFile), `.${randomUUID()}`);
  try {
    await rename(requestFile, away);
  } catch {
    return false;
  }
  await rm(away, { force: true });
  return true;
}

/** Places `text` as the request, which fails while another waits: the agent never reads half
 * of one, and none replaces another. */
async function place(
  requestFile: string,
  id: string,
  text: string
): Promise<void> {
  const next = path.join(path.dirname(requestFile), `.${id}`);
  await writeFile(next, text);
  try {
    await link(next, requestFile);
  } catch {
    throw new AgentRefusal(
      'pending',
      'an earlier request still waits for the host agent'
    );
  } finally {
    await unlink(next).catch(() => undefined);
  }
}

/** Places `request`, waits until the agent took and answered it, and throws its refusal. */
async function deliver(
  files: {
    requestFile: string;
    resultFile: string;
    now: () => number;
  },
  request: AgentRequest,
  deadline: number
): Promise<void> {
  const { requestFile, resultFile, now } = files;
  const notTaken =
    'the host agent did not take the request in time: it may be busy with an update or the upgrades switch, not installed (setup/agent.sh install, deploy/README.md step 8), or its path unit failed (journalctl -u <name>-agent.service, then systemctl reset-failed <name>-agent.path and start it)';
  const takeUntil = deadline - ANSWER_RESERVE_MS;
  if (now() >= takeUntil) {
    // Its turn came too late: an earlier request kept the agent busy.
    throw new AgentRefusal('notTaken', notTaken);
  }
  const id = randomUUID();
  await place(requestFile, id, requestText(id, request));
  if (
    !(await waitFor(
      async () => !(await exists(requestFile)),
      takeUntil - now(),
      now
    )) &&
    (await withdraw(requestFile))
  ) {
    throw new AgentRefusal('notTaken', notTaken);
  }
  let answer: Answer | undefined;
  const answered = await waitFor(
    async () => {
      answer = await readAnswer(resultFile);
      return answer?.id === id;
    },
    Math.max(0, deadline - now()),
    now
  );
  if (!answered || answer === undefined) {
    throw new AgentRefusal(
      'notTaken',
      'the host agent took the request but did not answer it; its journal says why'
    );
  }
  if (!answer.ok) {
    throw new AgentRefusal(
      'refused',
      `the host agent refused: ${answer.reason ?? 'no reason given'}`
    );
  }
}

/** The agent of the stack directory whose `.update` is mounted at `update`. */
export function createAgent(
  update: string,
  options: { now?: () => number } = {}
): Agent {
  const now = options.now ?? Date.now;
  const requestFile = path.join(update, 'requests', 'request');
  const resultFile = path.join(update, 'result');
  let queue: Promise<unknown> = Promise.resolve();

  return {
    present: async () =>
      (await exists(path.join(update, 'agent'))) &&
      exists(path.join(update, 'stack.json')),
    state: () => {
      try {
        return settle(
          JSON.parse(
            readFileSync(path.join(update, 'state.json'), 'utf8')
          ) as UpdateState,
          now()
        );
      } catch {
        return { state: 'idle' };
      }
    },
    host: async () => {
      try {
        return JSON.parse(
          await readFile(path.join(update, 'host.json'), 'utf8')
        ) as HostStatus;
      } catch {
        return undefined;
      }
    },
    // One request at a time: the agent answers one at a time, and a second request placed while
    // the first waits for its answer would take its answer's place.
    send: async (request, deadline) => {
      const turn = queue.then(async () =>
        deliver({ requestFile, resultFile, now }, request, deadline)
      );
      queue = turn.catch(() => undefined);
      return turn;
    }
  };
}
