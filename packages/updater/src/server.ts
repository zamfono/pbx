import { timingSafeEqual } from 'node:crypto';
import http from 'node:http';

import type { RunRequester, UpdaterStatus, UpdateState } from '@zamfono/shared';

import {
  compareVersions,
  formatVersion,
  isBreaking,
  judgeUpdate,
  parseVersion,
  type Version
} from './policy.js';
import type { Releases } from './releases.js';
import type { Runner } from './runner.js';

/**
 * The updater's HTTP API on the stack's internal network (§6.3 "Updates"), no port published:
 * `GET /status` and `POST /update`, each only with `UPDATER_TOKEN`, which `api` alone holds.
 */
const STATUS_OK = 200;
const STATUS_ACCEPTED = 202;
const STATUS_BAD_REQUEST = 400;
const STATUS_UNAUTHORIZED = 401;
const STATUS_NOT_FOUND = 404;
const STATUS_CONFLICT = 409;
const STATUS_UNAVAILABLE = 503;
const MAX_BODY_BYTES = 4096;
const MAX_BY_LENGTH = 200;

export type ServerDeps = {
  token: string;
  releases: Releases;
  /** The version the stack directory runs, read afresh on every request. */
  currentVersion: () => Promise<Version | undefined>;
  /** `undefined` when the updater could not learn its Compose project, with `unavailable` why. */
  runner: Runner | undefined;
  unavailable?: string;
};

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message);
  }
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
      throw new HttpError(STATUS_BAD_REQUEST, 'request body too large');
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
    throw new HttpError(STATUS_BAD_REQUEST, 'request body is not JSON');
  }
}

async function describeStatus(deps: ServerDeps): Promise<UpdaterStatus> {
  const current = await deps.currentVersion();
  const base = {
    current: current === undefined ? null : formatVersion(current),
    last: deps.runner?.current() ?? { state: 'idle' as const },
    ...(deps.unavailable === undefined ? {} : { unavailable: deps.unavailable })
  };
  try {
    const latest = await deps.releases.latest();
    const newer =
      latest !== undefined &&
      current !== undefined &&
      compareVersions(latest.version, current) > 0;
    const breaking = newer && isBreaking(current, latest.version);
    return {
      ...base,
      latest:
        latest === undefined
          ? null
          : { ...latest, version: formatVersion(latest.version) },
      updatable: newer && !breaking && deps.runner !== undefined,
      breaking
    };
  } catch (error) {
    return {
      ...base,
      latest: null,
      latestError: error instanceof Error ? error.message : String(error),
      updatable: false,
      breaking: false
    };
  }
}

/** Who `body` says asks for the run, recorded with it; `undefined` when it says nothing. */
function requesterOf(body: unknown): RunRequester | undefined {
  const { trigger, by } = body as { trigger?: unknown; by?: unknown };
  if (trigger === undefined && by === undefined) {
    return undefined;
  }
  if (trigger !== 'manual' && trigger !== 'automatic') {
    throw new HttpError(
      STATUS_BAD_REQUEST,
      'trigger must be manual or automatic'
    );
  }
  if (
    by !== undefined &&
    (typeof by !== 'string' || by.length > MAX_BY_LENGTH)
  ) {
    throw new HttpError(
      STATUS_BAD_REQUEST,
      `by must be a string of at most ${String(MAX_BY_LENGTH)} characters`
    );
  }
  return by === undefined ? { trigger } : { trigger, by };
}

async function update(deps: ServerDeps, body: unknown): Promise<UpdateState> {
  if (deps.runner === undefined) {
    throw new HttpError(STATUS_UNAVAILABLE, deps.unavailable ?? 'no runner');
  }
  if (deps.runner.current().state === 'running') {
    throw new HttpError(STATUS_CONFLICT, 'an update is already running');
  }
  const current = await deps.currentVersion();
  if (current === undefined) {
    throw new HttpError(
      STATUS_CONFLICT,
      'the stack directory pins no release; update it once with update.sh on the host'
    );
  }
  const requester = requesterOf(body);
  const asked = (body as { version?: unknown }).version;
  const askedVersion =
    typeof asked === 'string' ? parseVersion(asked) : undefined;
  if (asked !== undefined && askedVersion === undefined) {
    throw new HttpError(STATUS_BAD_REQUEST, 'version must be X.Y.Z');
  }
  const release =
    askedVersion === undefined
      ? await deps.releases.latest()
      : await deps.releases.byVersion(formatVersion(askedVersion));
  if (release === undefined) {
    throw new HttpError(
      STATUS_NOT_FOUND,
      askedVersion === undefined
        ? 'GitHub lists no release'
        : `there is no published release ${formatVersion(askedVersion)}`
    );
  }
  const verdict = judgeUpdate(current, release.version);
  if (!verdict.ok) {
    throw new HttpError(STATUS_CONFLICT, verdict.message);
  }
  await deps.runner.start(
    formatVersion(current),
    formatVersion(release.version),
    requester
  );
  return deps.runner.current();
}

function send(
  response: http.ServerResponse,
  code: number,
  body: unknown
): void {
  response.writeHead(code, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
}

async function route(
  deps: ServerDeps,
  request: http.IncomingMessage
): Promise<[number, unknown]> {
  if (deps.token === '') {
    throw new HttpError(STATUS_UNAVAILABLE, 'UPDATER_TOKEN is not set');
  }
  if (!authorized(request.headers.authorization, deps.token)) {
    throw new HttpError(STATUS_UNAUTHORIZED, 'missing or wrong token');
  }
  const key = `${request.method ?? ''} ${request.url ?? ''}`;
  if (key === 'GET /status') {
    return [STATUS_OK, await describeStatus(deps)];
  }
  if (key === 'POST /update') {
    return [STATUS_ACCEPTED, await update(deps, await readBody(request))];
  }
  throw new HttpError(STATUS_NOT_FOUND, `no route ${key}`);
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
        send(response, STATUS_UNAVAILABLE, {
          error: error instanceof Error ? error.message : String(error)
        });
      }
    );
  });
}
