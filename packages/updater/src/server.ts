import { timingSafeEqual } from 'node:crypto';
import http from 'node:http';

import type { UpdateState } from '@zamfono/shared';

import { AgentRefusal, REQUEST_BUDGET_MS, type Agent } from './agent.js';
import { errorMessage, HttpError } from './errors.js';
import { hostRoute } from './hostRoutes.js';
import { recordSince } from './record.js';
import { GitHubRateLimited, type Releases } from './releases.js';
import type { UpdateVerdict } from './stack.js';
import { describeStatus, unavailable } from './status.js';
import {
  breakingOf,
  edgeTarget,
  PINS_NO_RELEASE,
  refusal,
  releaseTarget,
  requesterOf
} from './updateRequest.js';
import { EDGE, formatStackVersion, type StackVersion } from './version.js';

/**
 * The updater's HTTP API on the stack's internal network (§6.3 "Updates"), no port published:
 * `GET /status` and `POST /check`, each with `api`'s own commit as `?revision=`, and
 * `POST /update`, which the host agent carries out (`agent.ts`), and while `HOST_CONTROL` is `true` `GET /host`,
 * `POST /host/updates` and `POST /host/reboot` (§6.3 "Host control"), each only with
 * `UPDATER_TOKEN`, which `api` alone holds.
 */
const HTTP_OK = 200;
const HTTP_ACCEPTED = 202;
const HTTP_BAD_REQUEST = 400;
const HTTP_UNAUTHORIZED = 401;
const HTTP_NOT_FOUND = 404;
const HTTP_CONFLICT = 409;
const HTTP_SERVICE_UNAVAILABLE = 503;
const MAX_BODY_BYTES = 4096;
const MS_PER_SECOND = 1000;
/** How long after its call `POST /update` answers at the latest, the run's record included:
 * inside api's 10 s wait for the updater. */
const RESPONSE_BUDGET_MS = 9000;

export type ServerDeps = {
  /** `undefined` while `UPDATER_TOKEN` is not set, which refuses every request. */
  token: string | undefined;
  releases: Releases;
  /** The version the stack directory runs, read afresh on every request. */
  currentVersion: () => Promise<StackVersion | undefined>;
  /** `update.sh --check`'s verdict on an update to a release (stack.ts), the one judge of it. */
  checkUpdate: (version: string) => Promise<UpdateVerdict>;
  agent: Agent;
  /** `HOST_CONTROL` is `true` in the updater's own environment. */
  hostControl: boolean;
};

/** The agent's refusal to take a request as the updater answers it. */
export function passOnRefusal(error: unknown): never {
  if (error instanceof AgentRefusal) {
    throw new HttpError(
      error.reason === 'notTaken' ? HTTP_SERVICE_UNAVAILABLE : HTTP_CONFLICT,
      error.message
    );
  }
  throw error;
}

function authorized(header: string | undefined, token: string): boolean {
  const expected = Buffer.from(`Bearer ${token}`);
  const given = Buffer.from(header ?? '');
  return given.length === expected.length && timingSafeEqual(given, expected);
}

async function readBody(request: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > MAX_BODY_BYTES) {
      throw new HttpError(HTTP_BAD_REQUEST, 'request body too large');
    }
    chunks.push(buffer);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if (text === '') {
    return {};
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(HTTP_BAD_REQUEST, 'request body is not JSON');
  }
}

async function update(
  deps: ServerDeps,
  body: unknown,
  started: number
): Promise<UpdateState> {
  const reason = await unavailable(deps);
  if (reason !== undefined) {
    throw new HttpError(HTTP_SERVICE_UNAVAILABLE, reason);
  }
  if (deps.agent.state().state === 'running') {
    throw new HttpError(HTTP_CONFLICT, 'an update is already running');
  }
  const current = await deps.currentVersion();
  if (current === undefined) {
    throw new HttpError(HTTP_CONFLICT, PINS_NO_RELEASE);
  }
  const requester = requesterOf(body);
  const breaking = breakingOf(body, requester);
  const asked = (body as { version?: unknown }).version;
  const to =
    current === EDGE ? edgeTarget(asked) : await releaseTarget(deps, asked);
  const verdict = await deps.checkUpdate(to);
  if (verdict !== 'update' && !(verdict === 'breaking' && breaking)) {
    throw new HttpError(
      HTTP_CONFLICT,
      refusal(verdict, formatStackVersion(current), to)
    );
  }
  // The record's startedAt has whole milliseconds; the agent's run starts after this anyway.
  const sentAt = Math.floor(Date.now() / MS_PER_SECOND) * MS_PER_SECOND;
  await deps.agent
    .send(
      {
        action: 'update',
        version: to,
        breaking: verdict === 'breaking',
        requester
      },
      started + REQUEST_BUDGET_MS
    )
    .catch(passOnRefusal);
  return recordSince(
    deps.agent,
    sentAt,
    Math.max(0, started + RESPONSE_BUDGET_MS - Date.now())
  );
}

function send(
  response: http.ServerResponse,
  code: number,
  body: unknown,
  headers: Record<string, string> = {}
): void {
  response.writeHead(code, { 'content-type': 'application/json', ...headers });
  response.end(JSON.stringify(body));
}

async function route(
  deps: ServerDeps,
  request: http.IncomingMessage
): Promise<[number, unknown]> {
  if (deps.token === undefined) {
    throw new HttpError(HTTP_SERVICE_UNAVAILABLE, 'UPDATER_TOKEN is not set');
  }
  if (!authorized(request.headers.authorization, deps.token)) {
    throw new HttpError(HTTP_UNAUTHORIZED, 'missing or wrong token');
  }
  const started = Date.now();
  const url = new URL(request.url ?? '/', 'http://updater');
  const revision = url.searchParams.get('revision') ?? undefined;
  const key = `${request.method ?? ''} ${url.pathname}`;
  if (key === 'GET /status') {
    return [HTTP_OK, await describeStatus(deps, false, revision)];
  }
  if (key === 'POST /check') {
    return [HTTP_OK, await describeStatus(deps, true, revision)];
  }
  if (key === 'POST /update') {
    return [
      HTTP_ACCEPTED,
      await update(deps, await readBody(request), started)
    ];
  }
  if (url.pathname.startsWith('/host')) {
    return hostRoute(deps, key, async () => readBody(request), started);
  }
  throw new HttpError(HTTP_NOT_FOUND, `no route ${key}`);
}

export function createServer(deps: ServerDeps): http.Server {
  return http.createServer((request, response) => {
    route(deps, request).then(
      ([code, body]) => {
        send(response, code, body);
      },
      (error: unknown) => {
        if (error instanceof HttpError) {
          send(response, error.status, { error: error.message });
          return;
        }
        if (error instanceof GitHubRateLimited) {
          const seconds = Math.ceil(
            (error.retryAt - Date.now()) / MS_PER_SECOND
          );
          send(
            response,
            HTTP_SERVICE_UNAVAILABLE,
            { error: error.message },
            { 'retry-after': String(Math.max(1, seconds)) }
          );
          return;
        }
        send(response, HTTP_SERVICE_UNAVAILABLE, {
          error: errorMessage(error)
        });
      }
    );
  });
}
