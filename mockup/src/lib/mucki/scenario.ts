/**
 * A scripted Mucki conversation: trigger patterns in German and English, the roles it serves, and
 * an async script over small step functions (say, think, tool call, question, Show me, …) that the
 * engine provides. A role the scenario does not serve gets the API's own refusal: the engine runs
 * the scenario's `probe`, which the operation's gate refuses with 403.
 */
import type { ApiError } from '#lib/api/errors.js';
import type { Actor } from '#lib/api/ops/core.js';
import type { Role } from '#lib/api/types.js';

import type { Chip } from './types';

export type ToolResult<O> =
  | { ok: true; value: O }
  | { ok: false; error: ApiError | null; cancelled: boolean };

export type Reply = {
  text: string;
  /** Index of the option the reply picked, or null for free text. */
  choice: number | null;
};

export type Progress = {
  set: (
    index: number,
    state: 'running' | 'done' | 'failed',
    note?: string
  ) => void;
  finish: () => void;
};

export type ToolOptions<O> = {
  /** The card's one-line summary once the operation answered. */
  done?: (out: O) => string;
};

export type ScenarioCtx = {
  actor: Actor;
  /** The message that started the scenario. */
  text: string;
  now: Date;
  /** Streams a reply in light markdown. */
  say: (text: string) => Promise<void>;
  /** Shows the thinking indicator for a moment. */
  think: (ms?: number) => Promise<void>;
  /** Waits without the indicator (polling). */
  wait: (ms: number) => Promise<void>;
  /** Runs an operation as the signed-in person over MCP, with a tool card and, when the operation
   * asks for one, a confirmation card first. */
  tool: <O>(
    operation: string,
    input: unknown,
    options?: ToolOptions<O>
  ) => Promise<ToolResult<O>>;
  /** `tool`, ending the scenario with an explanation when the operation refuses or fails. */
  must: <O>(
    operation: string,
    input: unknown,
    options?: ToolOptions<O>
  ) => Promise<O>;
  /** Runs an operation without a card of its own (batch rows under a progress card). */
  quiet: <O>(operation: string, input: unknown) => Promise<ToolResult<O>>;
  /** Re-runs a read every `intervalMs` under one card until `until` holds; the last value, or
   * null when it never held. */
  poll: <O>(
    operation: string,
    input: unknown,
    until: (out: O) => boolean,
    options: ToolOptions<O> & {
      intervalMs: number;
      attempts: number;
      waiting?: (out: O) => string;
    }
  ) => Promise<O | null>;
  /** Asks a question with quick replies; `free` accepts any typed answer. */
  ask: (
    text: string,
    options: Chip[],
    settings?: { free?: boolean }
  ) => Promise<Reply>;
  showMe: (path: string, label: string, highlight?: string) => void;
  secret: (label: string, value: string, note?: string) => void;
  audio: (
    clip: string | null,
    durationS: number,
    title: string,
    stereo?: boolean
  ) => void;
  progress: (
    labelKey: string,
    labels: string[],
    operation?: string
  ) => Progress;
  refusal: (text: string) => void;
  /** Ends the scenario here. */
  stop: () => never;
};

export type Scenario = {
  id: string;
  roles: Role[];
  /** Any one set matches when every pattern of it matches; the longest matching set scores. */
  triggers: RegExp[][];
  /** An extra score from the text itself (e.g. pasted rows). */
  score?: (text: string) => number;
  /** A read the gates refuse for roles outside `roles`, to show the refusal honestly. */
  probe?: { operation: string; input: (actor: Actor) => unknown };
  run: (ctx: ScenarioCtx) => Promise<void>;
};

/** Thrown by `stop()`: the scenario ended on purpose. */
export class StopScenario extends Error {
  constructor() {
    super('scenario stopped');
    this.name = 'StopScenario';
  }
}

/** Thrown into a running script when its conversation was abandoned. */
export class Aborted extends Error {
  constructor() {
    super('conversation aborted');
    this.name = 'Aborted';
  }
}

const normalise = (text: string): string =>
  text.toLowerCase().replace(/\s+/gu, ' ');

/** The score of `scenario` for `text`: 0 when no trigger set matches. */
export function scoreScenario(scenario: Scenario, text: string): number {
  const normal = normalise(text);
  let best = 0;
  for (const set of scenario.triggers) {
    if (set.every(pattern => pattern.test(normal))) {
      best = Math.max(best, set.length);
    }
  }
  return best + (scenario.score?.(text) ?? 0);
}

/** The best-matching scenario for `text`, earlier ones winning ties, or null. */
export function matchScenario(
  scenarios: Scenario[],
  text: string
): Scenario | null {
  let winner: Scenario | null = null;
  let winnerScore = 0;
  for (const scenario of scenarios) {
    const score = scoreScenario(scenario, text);
    if (score > winnerScore) {
      winner = scenario;
      winnerScore = score;
    }
  }
  return winner;
}

/** The rows of a list result: the API's `{ items }` page or a bare array. */
export function itemsOf<T>(out: unknown): T[] {
  if (Array.isArray(out)) {
    return out as T[];
  }
  const items = (out as { items?: unknown } | null)?.items;
  return Array.isArray(items) ? (items as T[]) : [];
}
