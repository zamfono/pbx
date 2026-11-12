import { readFile } from 'node:fs/promises';
import path from 'node:path';

import {
  EDGE,
  formatVersion,
  parseVersion,
  type StackVersion,
  type Version
} from './version.js';

/**
 * What the stack directory runs, as the host agent reports it in `.update/stack.json` on every
 * run and `update.sh` at the end of each (§6.3 "Updates"), and the verdict on an update by
 * RELEASING.md's policy, which `update.sh` applies again to the run itself.
 */
export type UpdateVerdict = 'update' | 'breaking' | 'notNewer' | 'noRelease';

/** `.update/stack.json`: the release `update.sh --current` prints, `null` for none; the release an
 * update that stopped before its stack reported healthy installed (`.update-pending`); and why
 * `--current` failed. */
type StackReport = {
  current: string | null;
  pending?: string | null;
  error?: string;
};

export type Stack = {
  /** The release the stack runs, or `edge`; `undefined` for a directory that runs none. */
  currentVersion: () => Promise<StackVersion | undefined>;
  /** `update.sh --check <version>`'s verdict, from the report. */
  checkUpdate: (version: string) => Promise<UpdateVerdict>;
};

/** -1, 0 or 1 as `left` is older than, the same as or newer than `right`. */
function compare(left: Version, right: Version): number {
  const [part, other] = left
    .map((value, index) => [value, right[index] ?? 0] as const)
    .find(([value, of]) => value !== of) ?? [0, 0];
  return Math.sign(part - other);
}

/** RELEASING.md's policy: a new major from 1.0.0 on, a new minor while 0.x. */
function breaking(from: Version, to: Version): boolean {
  return from[0] === 0 && to[0] === 0 ? from[1] !== to[1] : from[0] !== to[0];
}

/** The verdict on taking a stack that runs `current` to `target`, as `update.sh --check` gives
 * it: an update to the release it runs is allowed while that update stopped before its stack
 * reported healthy (`pending`), which finishes it. */
export function verdictOn(
  current: StackVersion | undefined,
  pending: string | undefined,
  target: string
): UpdateVerdict {
  if (current === undefined) {
    return 'noRelease';
  }
  if (current === EDGE) {
    if (target !== EDGE) {
      throw new Error(
        `the stack follows edge, which takes no release ${target}`
      );
    }
    return 'update';
  }
  const to = parseVersion(target);
  if (to === undefined) {
    throw new Error(`${target} is not a release version (X.Y.Z)`);
  }
  const order = compare(to, current);
  if (order < 0 || (order === 0 && pending !== formatVersion(current))) {
    return 'notNewer';
  }
  return order > 0 && breaking(current, to) ? 'breaking' : 'update';
}

/** The stack directory as the report in `updateDir` says; it throws while there is none. */
export function createStack(updateDir: string): Stack {
  async function report(): Promise<StackReport> {
    const text = await readFile(path.join(updateDir, 'stack.json'), 'utf8');
    return JSON.parse(text) as StackReport;
  }
  async function current(): Promise<
    [StackVersion | undefined, string | undefined]
  > {
    const { current: printed, pending, error } = await report();
    if (error !== undefined) {
      throw new Error(`update.sh --current failed: ${error}`);
    }
    if (printed === null) {
      return [undefined, undefined];
    }
    const version = printed === EDGE ? EDGE : parseVersion(printed);
    if (version === undefined) {
      throw new Error(`update.sh --current printed ${printed}, no release`);
    }
    return [version, pending ?? undefined];
  }
  return {
    currentVersion: async () => (await current())[0],
    checkUpdate: async target => verdictOn(...(await current()), target)
  };
}
