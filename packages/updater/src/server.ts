import { timingSafeEqual } from 'node:crypto';
import http from 'node:http';

import type { RunRequester, UpdateState } from '@zamfono/shared';

import { errorMessage } from './errors.js';
import type { Releases } from './releases.js';
import type { Runner } from './runner.js';
import type { UpdateVerdict } from './stack.js';
import { describeStatus } from './status.js';
import {
  EDGE,
  formatStackVersion,
  formatVersion,
  parseVersion,
  type StackVersion
} from './version.js';

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
  'the stack directory runs no release to update from: .env sets ZAMFONO_VERSION to an immutable sha- build, or the directory has no VERSION file; update.sh --current says which';

export type ServerDeps = {
  /** `undefined` while `UPDATER_TOKEN` is not set, which refuses every request. */
  token: string | undefined;
  releases: Releases;
  /** The version the stack directory runs, read afresh on every request. */
  currentVersion: () => Promise<StackVersion | undefined>;
  /** `update.sh --check`'s verdict on an update to a release (stack.ts), the one judge of it. */
  checkUpdate: (version: string) => Promise<UpdateVerdict>;
  /** The commit the stack's running `api` was built from, which an `edge` stack's newest build
   * is newer than when they differ; `undefined` while it does not run. */
  runningRevision: () => Promise<string | undefined>;
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

/** Who `body` says asks for the run, recorded with it: `manual` with the owner in `by`, or
 * `automatic` without. */
function requesterOf(body: unknown): RunRequester {
  const { trigger, by } = body as { trigger?: unknown; by?: unknown };
  if (trigger === 'automatic' && by === undefined) {
    return { trigger };
  }
  if (trigger !== 'manual') {
    throw new HttpError(
      HTTP_BAD_REQUEST,
      'trigger must be manual, with by, or automatic, without'
    );
  }
  if (typeof by !== 'string' || by.length > MAX_BY_LENGTH) {
    throw new HttpError(
      HTTP_BAD_REQUEST,
      `by must be a string of at most ${String(MAX_BY_LENGTH)} characters`
    );
  }
  return { trigger, by };
}

/** The release `asked` names, `X.Y.Z`, or the latest one without it. */
async function releaseTarget(
  deps: ServerDeps,
  asked: unknown
): Promise<string> {
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
  return formatVersion(release.version);
}

/** A stack on `edge` takes main's newest build alone, `edge` or no version at all. */
function edgeTarget(asked: unknown): string {
  if (asked !== undefined && asked !== EDGE) {
    throw new HttpError(
      HTTP_CONFLICT,
      'the stack follows edge: it takes no release until .env sets ZAMFONO_VERSION to one, which update.sh on the host installs'
    );
  }
  return EDGE;
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
  const to =
    current === EDGE ? edgeTarget(asked) : await releaseTarget(deps, asked);
  const verdict = await deps.checkUpdate(to);
  if (verdict !== 'update') {
    throw new HttpError(
      HTTP_CONFLICT,
      refusal(verdict, formatStackVersion(current), to)
    );
  }
  await deps.runner.start(formatStackVersion(current), to, requester);
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
