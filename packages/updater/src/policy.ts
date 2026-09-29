/**
 * Which updates the updater carries out on its own (§6.3 "Updates"): only to a newer release
 * that RELEASING.md's policy calls non-breaking, the same major from 1.0.0 on and the same minor
 * while 0.x. A breaking update needs an operator reading its upgrade notes, so it is refused here
 * and left to `update.sh` on the host.
 */
export type Version = readonly [number, number, number];

const VERSION_PATTERN = /^(?<major>\d+)\.(?<minor>\d+)\.(?<patch>\d+)$/u;

/** `X.Y.Z`, with an optional leading `v`, as numbers; `undefined` for anything else. */
export function parseVersion(text: string): Version | undefined {
  const groups = VERSION_PATTERN.exec(text.replace(/^v/u, ''))?.groups;
  if (groups === undefined) {
    return undefined;
  }
  return [Number(groups.major), Number(groups.minor), Number(groups.patch)];
}

export function formatVersion(version: Version): string {
  return version.join('.');
}

/** Negative, zero or positive as `left` is older than, the same as or newer than `right`. */
export function compareVersions(left: Version, right: Version): number {
  const index = left.findIndex((part, at) => part !== right[at]);
  return index === -1 ? 0 : (left[index] ?? 0) - (right[index] ?? 0);
}

/** RELEASING.md: a new major is breaking from 1.0.0 on; while 0.x, a new minor is. */
export function isBreaking(from: Version, to: Version): boolean {
  if (from[0] === 0 && to[0] === 0) {
    return from[1] !== to[1];
  }
  return from[0] !== to[0];
}

export type Verdict =
  | { ok: true }
  | { ok: false; reason: 'breaking' | 'notNewer'; message: string };

/** Whether the updater may take the stack from `from` to `to` without an operator. */
export function judgeUpdate(from: Version, to: Version): Verdict {
  const fromText = formatVersion(from);
  const toText = formatVersion(to);
  if (compareVersions(to, from) <= 0) {
    return {
      ok: false,
      reason: 'notNewer',
      message: `${toText} is not newer than ${fromText}, which the stack runs`
    };
  }
  if (isBreaking(from, to)) {
    return {
      ok: false,
      reason: 'breaking',
      message: `${fromText} to ${toText} is a breaking update: read its upgrade notes and run update.sh on the host`
    };
  }
  return { ok: true };
}
