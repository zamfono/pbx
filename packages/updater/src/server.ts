import { timingSafeEqual } from 'node:crypto';
import http from 'node:http';

import type { RunRequester, UpdaterStatus, UpdateState } from '@zamfono/shared';

import { errorMessage } from './errors.js';
import type { Release, Releases } from './releases.js';
import type { Runner } from './runner.js';
import type { UpdateVerdict } from './stack.js';
import { formatVersion, parseVersion, type Version } from './version.js';

/**
 * The updater's HTTP API on the stack's internal network (§6.3 "Updates"), no port published:
 * `GET /status` and `POST /update`, each only with `UPDATER_TOKEN`, which `api` alone holds.
 */
const HTTP_OK = 200;
const HTTP_ACCEPTED = 202;
const HTTP_BAD_REQUEST = 400;
const HTTP_UNAUTHORIZED = 401;
const HTTP_NOT_FOUND = 404;
const HTTP_CONFLICT = 409;
const HTTP_SERVICE_UNAVAILABLE = 503;
const MAX_BODY_BYTES = 4096;
const MAX_BY_LENGTH = 200;
const PINS_NO_RELEASE =
  'the stack directory pins no release; update it once with update.sh on the host';

export type ServerDeps = {
  /** `undefined` while `UPDATER_TOKEN` is not set, which refuses every request. */
  token: string | undefined;
  releases: Releases;
  /** The version the stack directory runs, read afresh on every request. */
  currentVersion: () => Promise<Version | undefined>;
  /** `update.sh --check`'s verdict on an update to a release (stack.ts), the one judge of it. */
  checkUpdate: (version: string) => Promise<UpdateVerdict>;
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

async function describeStatus(deps: ServerDeps): Promise<UpdaterStatus> {
  const current = await deps.currentVersion();
  const base = {
    current: current === undefined ? null : formatVersion(current),
    last: deps.runner?.current() ?? { state: 'idle' as const },
    ...(deps.unavailable === undefined ? {} : { unavailable: deps.unavailable })
  };
  let latest: Release | undefined;
  try {
    latest = await deps.releases.latest();
  } catch (error) {
    return {
      ...base,
      latest: null,
      latestError: errorMessage(error),
      updatable: false,
      breaking: false
    };
  }
  const verdict =
    latest === undefined || current === undefined
      ? undefined
      : await deps.checkUpdate(formatVersion(latest.version));
  return {
    ...base,
    latest:
      latest === undefined
        ? null
        : { ...latest, version: formatVersion(latest.version) },
    updatable: verdict === 'update' && deps.runner !== undefined,
    breaking: verdict === 'breaking'
  };
}

/** Why the updater does not take the stack from `current` to `to`, by `update.sh --check`'s verdict. */
function refusal(
  verdict: Exclude<UpdateVerdict, 'update'>,
  current: string,
  to: string
): string {
  return {
    breaking: `${current} to ${to} is a breaking update: read its upgrade notes and run update.sh on the host`,
    notNewer: `${to} is not newer than ${current}, which the stack runs`,
    noRelease: PINS_NO_RELEASE
  }[verdict];
}

/** Who `body` says asks for the run, recorded with it. */
function requesterOf(body: unknown): RunRequester {
  const { trigger, by } = body as { trigger?: unknown; by?: unknown };
  if (trigger !== 'manual' && trigger !== 'automatic') {
    throw new HttpError(
      HTTP_BAD_REQUEST,
      'trigger must be manual or automatic'
    );
  }
  if (
    by !== undefined &&
    (typeof by !== 'string' || by.length > MAX_BY_LENGTH)
  ) {
    throw new HttpError(
      HTTP_BAD_REQUEST,
      `by must be a string of at most ${String(MAX_BY_LENGTH)} characters`
    );
  }
  return by === undefined ? { trigger } : { trigger, by };
}

async function update(deps: ServerDeps, body: unknown): Promise<UpdateState> {
  if (deps.runner === undefined) {
    throw new HttpError(
      HTTP_SERVICE_UNAVAILABLE,
      deps.unavailable ?? 'no runner'
    );
  }
  if (deps.runner.current().state === 'running') {
    throw new HttpError(HTTP_CONFLICT, 'an update is already running');
  }
  const current = await deps.currentVersion();
  if (current === undefined) {
    throw new HttpError(HTTP_CONFLICT, PINS_NO_RELEASE);
  }
  const requester = requesterOf(body);
  const asked = (body as { version?: unknown }).version;
  const askedVersion =
    typeof asked === 'string' ? parseVersion(asked) : undefined;
  if (asked !== undefined && askedVersion === undefined) {
    throw new HttpError(HTTP_BAD_REQUEST, 'version must be X.Y.Z');
  }
  const release =
    askedVersion === undefined
      ? await deps.releases.latest()
      : await deps.releases.byVersion(formatVersion(askedVersion));
  if (release === undefined) {
    throw new HttpError(
      HTTP_NOT_FOUND,
      askedVersion === undefined
        ? 'GitHub lists no release'
        : `there is no published release ${formatVersion(askedVersion)}`
    );
  }
  const to = formatVersion(release.version);
  const verdict = await deps.checkUpdate(to);
  if (verdict !== 'update') {
    throw new HttpError(
      HTTP_CONFLICT,
      refusal(verdict, formatVersion(current), to)
    );
  }
  await deps.runner.start(formatVersion(current), to, requester);
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
  if (deps.token === undefined) {
    throw new HttpError(HTTP_SERVICE_UNAVAILABLE, 'UPDATER_TOKEN is not set');
  }
  if (!authorized(request.headers.authorization, deps.token)) {
    throw new HttpError(HTTP_UNAUTHORIZED, 'missing or wrong token');
  }
  const key = `${request.method ?? ''} ${request.url ?? ''}`;
  if (key === 'GET /status') {
    return [HTTP_OK, await describeStatus(deps)];
  }
  if (key === 'POST /update') {
    return [HTTP_ACCEPTED, await update(deps, await readBody(request))];
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
        send(response, HTTP_SERVICE_UNAVAILABLE, {
          error: errorMessage(error)
        });
      }
    );
  });
}
