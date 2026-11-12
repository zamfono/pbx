import type { RunRequester } from '@zamfono/shared';

import { HttpError } from './errors.js';
import type { ServerDeps } from './server.js';
import type { UpdateVerdict } from './stack.js';
import { EDGE, formatVersion, parseVersion } from './version.js';

/** What `POST /update`'s body asks for, checked (§6.3 "Updates"). */
const HTTP_BAD_REQUEST = 400;
const HTTP_NOT_FOUND = 404;
const HTTP_CONFLICT = 409;
const MAX_BY_LENGTH = 200;
export const PINS_NO_RELEASE =
  'the stack directory runs no release to update from: .env sets ZAMFONO_VERSION to an immutable sha- build, or the directory has no VERSION file; update.sh --current says which';

/** Why the updater does not take the stack from `current` to `to`, by `update.sh --check`'s verdict. */
export function refusal(
  verdict: Exclude<UpdateVerdict, 'update'>,
  current: string,
  to: string
): string {
  return {
    breaking: `${current} to ${to} is a breaking update: read its upgrade notes, then ask again with breaking set, or run update.sh on the host`,
    notNewer: `${to} is not newer than ${current}, which the stack runs`,
    noRelease: PINS_NO_RELEASE
  }[verdict];
}

/** Who `body` says asks for the run, recorded with it: `manual` with the owner in `by`, or
 * `automatic` without. */
export function requesterOf(body: unknown): RunRequester {
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

  if (
    typeof by !== 'string' ||
    by === '' ||
    // Bytes, as the host agent counts them.
    Buffer.byteLength(by) > MAX_BY_LENGTH ||
    /\p{Cc}/u.test(by)
  ) {
    throw new HttpError(
      HTTP_BAD_REQUEST,
      `by must be a name of 1 to ${String(MAX_BY_LENGTH)} bytes, without control characters`
    );
  }
  return { trigger, by };
}

/** The release `asked` names, `X.Y.Z`, or the latest one without it. */
export async function releaseTarget(
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
export function edgeTarget(asked: unknown): string {
  if (asked !== undefined && asked !== EDGE) {
    throw new HttpError(
      HTTP_CONFLICT,
      'the stack follows edge: it takes no release until .env sets ZAMFONO_VERSION to one, which update.sh on the host installs'
    );
  }
  return EDGE;
}

/** Whether `body` takes a breaking release, which only an owner's run does. */
export function breakingOf(body: unknown, requester: RunRequester): boolean {
  const { breaking } = body as { breaking?: unknown };
  if (breaking === undefined) {
    return false;
  }
  if (typeof breaking !== 'boolean' || requester.trigger !== 'manual') {
    throw new HttpError(
      HTTP_BAD_REQUEST,
      'breaking must be a boolean, and only with trigger manual'
    );
  }
  return breaking;
}
