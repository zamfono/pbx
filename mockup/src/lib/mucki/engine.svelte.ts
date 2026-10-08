/**
 * Mucki's conversation engine: one history per persona, persisted; free text matched to a scenario
 * (or a fallback naming what the demo covers); scenario scripts run with streaming replies, tool
 * cards, confirmation cards and questions. Operations run through `deps.call`, which the app wires
 * to the operations layer as the signed-in person on channel `mcp` (client Mucki).
 */
import { ApiError } from '#lib/api/errors.js';
import {
  ConfirmationRequired,
  type Actor,
  type ConfirmInfo
} from '#lib/api/ops/core.js';
import type { PersonaKey } from '#lib/api/seed/ids.js';
import { now as demoNow, nowDate as demoNowDate } from '#lib/clock.svelte.js';
import { t } from '#lib/i18n/index.svelte.js';

import { streamChunks } from './markdown';
import {
  Aborted,
  matchScenario,
  StopScenario,
  type Progress,
  type Reply,
  type Scenario,
  type ScenarioCtx,
  type ToolOptions,
  type ToolResult
} from './scenario';
import type {
  AssistantMessage,
  Chip,
  ConfirmMessage,
  Histories,
  Message,
  NewMessage,
  ProgressMessage,
  ToolMessage
} from './types';

export const STORAGE_KEY = 'zamfono-mockup:mucki:v1';
const SAVE_DELAY_MS = 250;
const RESULT_MAX_CHARS = 4000;

type KeyStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

export type EngineDeps = {
  persona: () => PersonaKey;
  actor: () => Actor;
  /** Runs an operation as `actor()` over MCP; throws the operation's `ApiError`. */
  call: (operation: string, input: unknown, confirmed: boolean) => unknown;
  confirmationFor: (operation: string, input: unknown) => ConfirmInfo | null;
  /** Whether the gates let `actor()` run the operation (a refused one is called unconfirmed). */
  allowed: (operation: string, input: unknown) => boolean;
  scenarios: Scenario[];
  /** Fallback chips for a persona whose request matched nothing. */
  capabilities: (actor: Actor) => Chip[];
  delay?: (ms: number) => Promise<void>;
  /** 1 for the demo's pace, 0 in tests. */
  pace?: number;
  storage?: KeyStorage | null;
  now?: () => Date;
  random?: () => number;
};

type Question = {
  persona: PersonaKey;
  messageId: string;
  options: Chip[];
  free: boolean;
  resolve: (reply: Reply) => void;
  reject: (error: Error) => void;
};

const emptyHistories = (): Histories => ({ lea: [], jonas: [], mira: [] });

let counter = 0;
const nextId = (): string =>
  `m${demoNow().toString(36)}${(counter++).toString(36)}`;

function jsonOf(value: unknown): string {
  try {
    const text = JSON.stringify(value, null, 2) ?? 'null';
    return text.length > RESULT_MAX_CHARS
      ? `${text.slice(0, RESULT_MAX_CHARS)}\n…`
      : text;
  } catch {
    return String(value);
  }
}

function plain<T>(value: T): T {
  try {
    return JSON.parse(JSON.stringify(value ?? null)) as T;
  } catch {
    return value;
  }
}

/** An `ApiError`'s text in the person's language, as the screens show it. */
export function errorText(error: ApiError): string {
  return t(`errors.${error.code}`, { ...error.params, message: error.message });
}

/** A stored history without anything that was still in flight when it was saved. */
function settle(messages: Message[]): Message[] {
  return messages.map(message => {
    switch (message.kind) {
      case 'tool':
        return message.state === 'running' || message.state === 'awaiting'
          ? {
              ...message,
              state: 'cancelled',
              summary: t('mucki.tool.interrupted')
            }
          : message;
      case 'confirm':
        return message.state === 'pending'
          ? { ...message, state: 'cancelled' }
          : message;
      case 'assistant': {
        const { options: _options, streaming: _streaming, ...rest } = message;
        return rest;
      }
      case 'progress':
        return { ...message, finished: true };
      default:
        return message;
    }
  });
}

export class MuckiEngine {
  histories = $state<Histories>(emptyHistories());
  /** The persona a turn is running for, or null when idle. */
  busyFor = $state<PersonaKey | null>(null);
  thinking = $state(false);

  #deps: EngineDeps;
  #token = 0;
  /** The scenario the running turn follows. */
  #scenarioId: string | null = null;
  #question: Question | null = null;
  #confirms = new Map<string, (confirmed: boolean) => void>();
  #saveTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(deps: EngineDeps) {
    this.#deps = deps;
    this.histories = this.#load();
  }

  /* ---------------- public API ---------------- */

  /** The open question of `persona`'s conversation, for the composer's chips. */
  awaitingAnswer(persona: PersonaKey): boolean {
    return this.#question?.persona === persona;
  }

  isBusy(persona: PersonaKey): boolean {
    return this.busyFor === persona;
  }

  /** Sends what the person typed or a chip sent. */
  async send(raw: string): Promise<void> {
    const text = raw.trim();
    if (text === '') {
      return;
    }
    const persona = this.#deps.persona();
    const question = this.#question;
    if (question !== null && question.persona === persona) {
      this.#add(persona, { kind: 'user', text });
      this.#dropOptions(persona, question.messageId);
      const choice = question.options.findIndex(
        option =>
          (option.prompt ?? option.label).toLowerCase() === text.toLowerCase()
      );
      const match =
        choice === -1 ? matchScenario(this.#deps.scenarios, text) : null;
      const other =
        match !== null && match.id !== this.#scenarioId ? match : null;
      this.#question = null;
      if (other === null) {
        question.resolve({ text, choice: choice === -1 ? null : choice });
        return;
      }
      // A new request instead of an answer: leave the old script and start over.
      this.#abortRun(question);
      await this.#turn(persona, text);
      return;
    }
    if (this.busyFor !== null) {
      return;
    }
    this.#add(persona, { kind: 'user', text });
    await this.#turn(persona, text);
  }

  /** The person's answer on a confirmation card. */
  decide(messageId: string, confirmed: boolean): void {
    const resolve = this.#confirms.get(messageId);
    if (resolve !== undefined) {
      this.#confirms.delete(messageId);
      resolve(confirmed);
    }
  }

  /** Clears `persona`'s conversation, ending a turn in flight. */
  newConversation(persona: PersonaKey): void {
    if (this.busyFor === persona || this.#question?.persona === persona) {
      this.abort();
    }
    this.histories[persona] = [];
    this.#save();
  }

  /** Clears every conversation (demo reset). */
  clearAll(): void {
    this.abort();
    this.histories = emptyHistories();
    try {
      this.#deps.storage?.removeItem(STORAGE_KEY);
    } catch {
      // Storage blocked: nothing persisted anyway.
    }
  }

  /** Ends the turn in flight, if any. */
  abort(): void {
    this.#abortRun(this.#question);
  }

  /** Ends a turn running for another persona than `persona` (the person switched). */
  follow(persona: PersonaKey): void {
    const running = this.busyFor ?? this.#question?.persona ?? null;
    if (running !== null && running !== persona) {
      this.abort();
    }
  }

  /* ---------------- turns ---------------- */

  #abortRun(question: Question | null): void {
    this.#token += 1;
    this.#question = null;
    question?.reject(new Aborted());
    for (const resolve of this.#confirms.values()) {
      resolve(false);
    }
    this.#confirms.clear();
    this.busyFor = null;
    this.thinking = false;
  }

  async #turn(persona: PersonaKey, text: string): Promise<void> {
    const token = ++this.#token;
    this.busyFor = persona;
    const ctx = this.#ctx(persona, text, token);
    try {
      await ctx.think(700);
      const scenario = matchScenario(this.#deps.scenarios, text);
      this.#scenarioId = scenario?.id ?? null;
      const actor = this.#deps.actor();
      if (scenario === null) {
        await this.#fallback(ctx, actor, persona);
      } else if (!scenario.roles.includes(actor.role)) {
        await this.#refuseRole(ctx, scenario, actor);
      } else {
        await scenario.run(ctx);
      }
    } catch (error) {
      if (!(error instanceof Aborted) && !(error instanceof StopScenario)) {
        if (token === this.#token) {
          this.#add(persona, {
            kind: 'error',
            text: t('mucki.error.unexpected', {
              message: error instanceof Error ? error.message : String(error)
            })
          });
        }
        console.error(error);
      }
    } finally {
      if (token === this.#token) {
        this.busyFor = null;
        this.thinking = false;
        if (this.#question?.persona === persona) {
          this.#question = null;
        }
      }
      this.#save();
    }
  }

  async #fallback(
    ctx: ScenarioCtx,
    actor: Actor,
    persona: PersonaKey
  ): Promise<void> {
    await ctx.say(t('mucki.fallback'));
    const last = this.histories[persona].at(-1);
    if (last?.kind === 'assistant') {
      last.options = this.#deps.capabilities(actor);
    }
  }

  async #refuseRole(
    ctx: ScenarioCtx,
    scenario: Scenario,
    actor: Actor
  ): Promise<void> {
    if (scenario.probe !== undefined) {
      const result = await ctx.tool(
        scenario.probe.operation,
        scenario.probe.input(actor)
      );
      if (!result.ok && result.error !== null && result.error.status === 403) {
        ctx.refusal(
          t('mucki.refusal.role', {
            role: t(`role.${actor.role}`),
            reason: errorText(result.error),
            who: t(
              scenario.roles.includes('admin')
                ? 'mucki.refusal.askAdmin'
                : 'mucki.refusal.askOwner'
            )
          })
        );
        return;
      }
      if (!result.ok) {
        return;
      }
    }
    ctx.refusal(
      t('mucki.refusal.notForRole', { role: t(`role.${actor.role}`) })
    );
  }

  /* ---------------- step functions ---------------- */

  #ctx(persona: PersonaKey, text: string, token: number): ScenarioCtx {
    const deps = this.#deps;
    const pace = deps.pace ?? 1;
    const random = deps.random ?? Math.random;
    const sleep =
      deps.delay ??
      ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)));
    const live = (): void => {
      if (token !== this.#token) {
        throw new Aborted();
      }
    };
    const pause = async (ms: number): Promise<void> => {
      await sleep(Math.round(ms * pace));
      live();
    };
    const add = <M extends NewMessage>(message: M): Message => {
      live();
      return this.#add(persona, message);
    };
    const stop = (): never => {
      throw new StopScenario();
    };

    const say = async (markdown: string): Promise<void> => {
      this.thinking = false;
      const message = add({
        kind: 'assistant',
        text: '',
        streaming: true
      }) as AssistantMessage;
      const chunks = streamChunks(markdown, 2);
      for (const chunk of chunks) {
        message.text = chunk;
        await pause(22);
      }
      message.text = markdown;
      message.streaming = false;
      this.#save();
    };

    const think = async (ms = 600): Promise<void> => {
      this.thinking = true;
      await pause(ms * (0.8 + random() * 0.5));
      this.thinking = false;
    };

    const confirmCard = async (
      operation: string,
      info: ConfirmInfo
    ): Promise<boolean> => {
      const card = add({
        kind: 'confirm',
        operation,
        title: t(`confirm.${info.key}.title`, info.params),
        body: t(`confirm.${info.key}.body`, info.params),
        action: t(`confirm.${info.key}.action`, info.params),
        irreversible: info.irreversible === true,
        destructive: info.destructive === true,
        state: 'pending'
      }) as ConfirmMessage;
      this.thinking = false;
      const confirmed = await new Promise<boolean>(resolve =>
        this.#confirms.set(card.id, resolve)
      );
      live();
      card.state = confirmed ? 'confirmed' : 'cancelled';
      this.#save();
      return confirmed;
    };

    /** Runs `operation`, asking first when it needs a confirmation the person may give. */
    const execute = async <O>(
      operation: string,
      input: unknown,
      onAwait: (awaiting: boolean) => void
    ): Promise<ToolResult<O>> => {
      let confirmed = false;
      let info: ConfirmInfo | null = null;
      try {
        info = deps.allowed(operation, input)
          ? deps.confirmationFor(operation, input)
          : null;
      } catch {
        info = null;
      }
      for (;;) {
        if (info !== null && !confirmed) {
          onAwait(true);
          if (!(await confirmCard(operation, info))) {
            return { ok: false, error: null, cancelled: true };
          }
          onAwait(false);
          confirmed = true;
          await pause(450);
        }
        try {
          return {
            ok: true,
            value: deps.call(operation, plain(input), confirmed) as O
          };
        } catch (error) {
          if (error instanceof ConfirmationRequired && !confirmed) {
            info = error.info;
            continue;
          }
          if (error instanceof ApiError) {
            return { ok: false, error, cancelled: false };
          }
          throw error;
        }
      }
    };

    const startCard = (operation: string, input: unknown): ToolMessage =>
      add({
        kind: 'tool',
        operation,
        input: plain(input),
        state: 'running',
        summary:
          t(`mucki.op.${operation}`) === `mucki.op.${operation}`
            ? t('mucki.tool.running')
            : t(`mucki.op.${operation}`)
      }) as ToolMessage;

    const finishCard = <O>(
      card: ToolMessage,
      result: ToolResult<O>,
      options: ToolOptions<O> = {}
    ): void => {
      if (result.ok) {
        card.state = 'done';
        card.summary = options.done?.(result.value) ?? t('mucki.tool.done');
        card.result = jsonOf(result.value);
      } else if (result.cancelled) {
        card.state = 'cancelled';
        card.summary = t('mucki.tool.cancelled');
      } else if (result.error !== null) {
        card.state = result.error.status === 403 ? 'refused' : 'error';
        card.summary =
          result.error.code === 'unknownOperation'
            ? t('mucki.tool.missing')
            : result.error.status === 403
              ? t('mucki.tool.refused')
              : errorText(result.error);
        card.error = {
          status: result.error.status,
          code: result.error.code,
          message: result.error.message
        };
      }
      this.#save();
    };

    const tool = async <O>(
      operation: string,
      input: unknown,
      options: ToolOptions<O> = {}
    ): Promise<ToolResult<O>> => {
      this.thinking = false;
      const card = startCard(operation, input);
      await pause(600 + random() * 800);
      const result = await execute<O>(operation, input, awaiting => {
        card.state = awaiting ? 'awaiting' : 'running';
        if (awaiting) {
          card.summary = t('mucki.tool.awaiting');
        }
      });
      live();
      finishCard(card, result, options);
      return result;
    };

    const explainFailure = (
      operation: string,
      result: ToolResult<unknown>
    ): void => {
      if (result.ok) {
        return;
      }
      if (result.cancelled) {
        add({ kind: 'assistant', text: t('mucki.cancelled') });
      } else if (result.error?.code === 'unknownOperation') {
        add({ kind: 'error', text: t('mucki.error.missing', { operation }) });
      } else if (result.error?.status === 403) {
        add({
          kind: 'refusal',
          text: t('mucki.refusal.generic', { reason: errorText(result.error) })
        });
      } else if (result.error !== null && result.error !== undefined) {
        const refs = result.error.refs.map(ref => ref.label).join(', ');
        add({
          kind: 'error',
          text: t('mucki.error.failed', {
            reason: errorText(result.error) + (refs === '' ? '' : ` ${refs}`)
          })
        });
      }
    };

    const must = async <O>(
      operation: string,
      input: unknown,
      options: ToolOptions<O> = {}
    ): Promise<O> => {
      const result = await tool<O>(operation, input, options);
      if (!result.ok) {
        explainFailure(operation, result);
        return stop();
      }
      return result.value;
    };

    const quiet = async <O>(
      operation: string,
      input: unknown
    ): Promise<ToolResult<O>> => {
      await pause(350 + random() * 450);
      const result = await execute<O>(operation, input, () => undefined);
      live();
      return result;
    };

    const poll = async <O>(
      operation: string,
      input: unknown,
      until: (out: O) => boolean,
      options: ToolOptions<O> & {
        intervalMs: number;
        attempts: number;
        waiting?: (out: O) => string;
      }
    ): Promise<O | null> => {
      this.thinking = false;
      const card = startCard(operation, input);
      let last: ToolResult<O> = { ok: false, error: null, cancelled: false };
      for (let attempt = 0; attempt < options.attempts; attempt += 1) {
        await pause(attempt === 0 ? 500 : options.intervalMs);
        last = await execute<O>(operation, input, () => undefined);
        live();
        if (!last.ok) {
          finishCard(card, last, options);
          explainFailure(operation, last);
          return stop();
        }
        if (until(last.value)) {
          finishCard(card, last, options);
          return last.value;
        }
        if (options.waiting !== undefined) {
          card.summary = options.waiting(last.value);
          card.result = jsonOf(last.value);
        }
      }
      card.state = 'done';
      this.#save();
      return null;
    };

    const ask = async (
      question: string,
      options: Chip[],
      settings: { free?: boolean } = {}
    ): Promise<Reply> => {
      await say(question);
      const message = this.histories[persona].at(-1);
      if (message?.kind === 'assistant' && options.length > 0) {
        message.options = options;
      }
      live();
      return new Promise<Reply>((resolve, reject) => {
        this.#question = {
          persona,
          messageId: message?.id ?? '',
          options,
          free: settings.free === true,
          resolve: reply => {
            this.thinking = true;
            resolve(reply);
          },
          reject
        };
      });
    };

    const progress = (
      labelKey: string,
      labels: string[],
      operation?: string
    ): Progress => {
      const card = add({
        kind: 'progress',
        labelKey,
        ...(operation === undefined ? {} : { operation }),
        items: labels.map(label => ({ label, state: 'pending' as const })),
        finished: false
      }) as ProgressMessage;
      return {
        set: (index, state, note) => {
          const item = card.items[index];
          if (item !== undefined) {
            item.state = state;
            if (note !== undefined) {
              item.note = note;
            }
          }
        },
        finish: () => {
          card.finished = true;
          this.#save();
        }
      };
    };

    return {
      actor: deps.actor(),
      text,
      now: deps.now?.() ?? demoNowDate(),
      say,
      think,
      wait: pause,
      tool,
      must,
      quiet,
      poll,
      ask,
      showMe: (path, label, highlight) => {
        add({
          kind: 'link',
          path,
          label,
          ...(highlight === undefined ? {} : { highlight })
        });
      },
      secret: (label, value, note) => {
        add({
          kind: 'secret',
          label,
          value,
          ...(note === undefined ? {} : { note })
        });
      },
      audio: (clip, durationS, title, stereo) => {
        add({
          kind: 'audio',
          clip,
          durationS,
          title,
          ...(stereo === true ? { stereo } : {})
        });
      },
      progress,
      refusal: refusalText => {
        add({ kind: 'refusal', text: refusalText });
      },
      stop
    };
  }

  /* ---------------- history ---------------- */

  #add(persona: PersonaKey, message: NewMessage): Message {
    const list = this.histories[persona];
    list.push({ ...message, id: nextId() } as Message);
    this.#save();
    return list[list.length - 1] as Message;
  }

  #dropOptions(persona: PersonaKey, messageId: string): void {
    const message = this.histories[persona].find(
      candidate => candidate.id === messageId
    );
    if (message?.kind === 'assistant') {
      delete message.options;
    }
  }

  #load(): Histories {
    try {
      const raw = this.#deps.storage?.getItem(STORAGE_KEY);
      if (raw !== null && raw !== undefined) {
        const stored = JSON.parse(raw) as Partial<Histories>;
        const histories = emptyHistories();
        for (const key of Object.keys(histories) as PersonaKey[]) {
          const list = stored[key];
          histories[key] = Array.isArray(list) ? settle(list) : [];
        }
        return histories;
      }
    } catch {
      // Unreadable or blocked storage: fresh conversations.
    }
    return emptyHistories();
  }

  #save(): void {
    if (this.#deps.storage === null || this.#deps.storage === undefined) {
      return;
    }
    clearTimeout(this.#saveTimer);
    this.#saveTimer = setTimeout(() => {
      try {
        this.#deps.storage?.setItem(
          STORAGE_KEY,
          JSON.stringify($state.snapshot(this.histories))
        );
      } catch {
        // Storage full or blocked: the conversation lasts for this page load.
      }
    }, SAVE_DELAY_MS);
  }
}
