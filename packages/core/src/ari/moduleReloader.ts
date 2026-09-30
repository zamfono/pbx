/**
 * One Asterisk module reload at a time, for every caller of `AriClient.asterisk.reloadModule`
 * (§3.1 "Config propagation"): the boot reload and each `/internal/configChanged`.
 *
 * Asterisk runs a single reload at a time and refuses one that arrives while another is running
 * (ARI `409 Another reload is currently in progress`), so reloads sent side by side lose all but
 * one: the boot reload of every module failed `core`'s start, and a refused PJSIP reload left a
 * written endpoint out of Asterisk. Reloads here run strictly one after another; a refusal that
 * only means another reload is running (one this process did not send, say from the Asterisk
 * CLI) is retried after a growing delay.
 *
 * A request for a module that is still waiting joins that waiting reload rather than queueing a
 * second one: it has not started, so it reads the rendered files as they are when it runs. A
 * request made while the module's reload is already running queues a fresh one, since the running
 * one may have read the files before the write that request reports.
 */
import { setTimeout as sleep } from 'node:timers/promises';

import { AriError, type AsteriskModule } from './types.js';

const HTTP_CONFLICT = 409;
// A doubling pause from 100 ms, capped at 2 s, eleven times: roughly fifteen seconds in all, far
// longer than a PJSIP reload of any real tenant, short enough that `api` hears of a reload
// Asterisk keeps refusing.
const FIRST_RETRY_DELAY_MS = 100;
const MAX_RETRY_DELAY_MS = 2000;
const BACKOFF_FACTOR = 2;
const MAX_RETRIES = 11;
const DEFAULT_RETRY_DELAYS_MS: readonly number[] = Array.from(
  { length: MAX_RETRIES },
  (_unused, retry) =>
    Math.min(FIRST_RETRY_DELAY_MS * BACKOFF_FACTOR ** retry, MAX_RETRY_DELAY_MS)
);

type Waiter = { resolve: () => void; reject: (error: unknown) => void };

export type ModuleReloaderOptions = {
  /** The pause before each retry of a refused reload; its length bounds the retries. */
  retryDelaysMs?: readonly number[];
  wait?: (ms: number) => Promise<void>;
};

/** Asterisk's refusal of a reload because another one is running, as ARI reports it. */
export function isReloadInProgress(error: unknown): boolean {
  if (!(error instanceof AriError) || error.status !== HTTP_CONFLICT) {
    return false;
  }
  const { message } = (error.body ?? {}) as { message?: unknown };
  return typeof message === 'string' && /in progress/iu.test(message);
}

export class ModuleReloader {
  // Waiting reloads in arrival order (a `Map` iterates in insertion order), none started yet.
  private readonly waiting = new Map<AsteriskModule, Waiter[]>();
  private running = false;
  private readonly retryDelaysMs: readonly number[];
  private readonly wait: (ms: number) => Promise<void>;

  constructor(
    private readonly reloadOnce: (module: AsteriskModule) => Promise<void>,
    options: ModuleReloaderOptions = {}
  ) {
    this.retryDelaysMs = options.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
    this.wait = options.wait ?? sleep;
  }

  /** Resolves once a reload of `module` that started after this call has finished. */
  reload(module: AsteriskModule): Promise<void> {
    return new Promise((resolve, reject) => {
      const waiters = this.waiting.get(module);
      if (waiters) {
        waiters.push({ resolve, reject });
      } else {
        this.waiting.set(module, [{ resolve, reject }]);
      }
      this.startNext();
    });
  }

  /** Starts the oldest waiting reload unless one is running; each finished one starts the next. */
  private startNext(): void {
    const next = this.waiting.entries().next();
    if (this.running || next.done === true) {
      return;
    }
    const [module, waiters] = next.value;
    this.waiting.delete(module);
    this.running = true;
    // `run` settles every waiter itself and never rejects.
    this.run(module, waiters).catch(() => undefined);
  }

  private async run(module: AsteriskModule, waiters: Waiter[]): Promise<void> {
    try {
      await this.reloadWithRetry(module, 0);
      for (const waiter of waiters) {
        waiter.resolve();
      }
    } catch (error) {
      for (const waiter of waiters) {
        waiter.reject(error);
      }
    }
    this.running = false;
    this.startNext();
  }

  private async reloadWithRetry(
    module: AsteriskModule,
    attempt: number
  ): Promise<void> {
    try {
      await this.reloadOnce(module);
    } catch (error) {
      const delay = this.retryDelaysMs[attempt];
      if (delay === undefined || !isReloadInProgress(error)) {
        throw error;
      }
      await this.wait(delay);
      await this.reloadWithRetry(module, attempt + 1);
    }
  }
}
