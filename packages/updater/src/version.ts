/** A release's `X.Y.Z`, as numbers. */
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

/** The tag of main's newest build, which a stack following it names as the version it runs. */
export const EDGE = 'edge';

/** What a stack directory runs, by `update.sh --current`: a release, or main's newest build. */
export type StackVersion = Version | typeof EDGE;

export function formatStackVersion(version: StackVersion): string {
  return version === EDGE ? EDGE : formatVersion(version);
}
