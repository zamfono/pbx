import { once } from 'node:events';
import http from 'node:http';
import { setImmediate } from 'node:timers/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Runner } from './runner.js';
import { STOP_WAIT_MS, stopOnSignal } from './stop.js';

const logged: string[] = [];
let listenersBefore = new Set<unknown>();

/** A listening server and a runner whose own run ends when `idle` resolves. */
async function boot(idle: Promise<void>): Promise<http.Server> {
  const server = http.createServer();
  server.listen(0);
  await once(server, 'listening');
  const runner: Runner = {
    current: () => ({ state: 'idle' }),
    start: () => Promise.reject(new Error()),
    idle: () => idle
  };
  listenersBefore = new Set([
    ...process.listeners('SIGTERM'),
    ...process.listeners('SIGINT')
  ]);
  stopOnSignal(server, runner, message => {
    logged.push(message);
  });
  return server;
}

/** The `name` handlers `stopOnSignal` added, leaving out the test runner's own. */
function handlersOf(name: 'SIGTERM' | 'SIGINT') {
  return process
    .listeners(name)
    .filter(listener => !listenersBefore.has(listener));
}

function signal(name: 'SIGTERM' | 'SIGINT'): void {
  for (const listener of handlersOf(name)) {
    listener(name);
  }
}

afterEach(() => {
  for (const name of ['SIGTERM', 'SIGINT'] as const) {
    for (const listener of handlersOf(name)) {
      process.off(name, listener);
    }
  }
  vi.useRealTimers();
  vi.restoreAllMocks();
  logged.length = 0;
});

describe('stopOnSignal', () => {
  it('closes the server and exits 0 on SIGTERM while no update runs', async () => {
    const server = await boot(Promise.resolve());
    const exit = vi.spyOn(process, 'exit').mockReturnValue(undefined as never);

    signal('SIGTERM');

    expect(server.listening).toBe(false);
    await vi.waitFor(() => {
      expect(exit).toHaveBeenCalledWith(0);
    });
    expect(logged).toEqual(['updater stopping']);
  });

  it('exits on SIGINT, once only on a second signal', async () => {
    await boot(Promise.resolve());
    const exit = vi.spyOn(process, 'exit').mockReturnValue(undefined as never);

    signal('SIGINT');
    signal('SIGTERM');

    await vi.waitFor(() => {
      expect(exit).toHaveBeenCalledWith(0);
    });
    expect(exit).toHaveBeenCalledTimes(1);
  });

  it('waits for its own update to end before it exits', async () => {
    const run = Promise.withResolvers<undefined>();
    await boot(run.promise);
    const exit = vi.spyOn(process, 'exit').mockReturnValue(undefined as never);

    signal('SIGTERM');
    await setImmediate();
    expect(exit).not.toHaveBeenCalled();

    run.resolve(undefined);
    await vi.waitFor(() => {
      expect(exit).toHaveBeenCalledWith(0);
    });
  });

  it('exits after STOP_WAIT_MS with its update still running, and says so', async () => {
    await boot(Promise.withResolvers<undefined>().promise);
    const exit = vi.spyOn(process, 'exit').mockReturnValue(undefined as never);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

    signal('SIGTERM');
    await vi.advanceTimersByTimeAsync(STOP_WAIT_MS);

    expect(exit).toHaveBeenCalledWith(0);
    expect(logged).toContain('updater stopping before its update ended');
  });
});
