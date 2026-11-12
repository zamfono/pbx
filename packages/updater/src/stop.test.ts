import { once } from 'node:events';
import http from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { stopOnSignal } from './stop.js';

const logged: string[] = [];
let listenersBefore = new Set<unknown>();

/** A listening server. */
async function boot(): Promise<http.Server> {
  const server = http.createServer();
  server.listen(0);
  await once(server, 'listening');
  listenersBefore = new Set([
    ...process.listeners('SIGTERM'),
    ...process.listeners('SIGINT')
  ]);
  stopOnSignal(server, message => {
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
  vi.restoreAllMocks();
  logged.length = 0;
});

describe('stopOnSignal', () => {
  it('closes the server and exits 0 on SIGTERM', async () => {
    const server = await boot();
    const exit = vi.spyOn(process, 'exit').mockReturnValue(undefined as never);

    signal('SIGTERM');

    expect(server.listening).toBe(false);
    await vi.waitFor(() => {
      expect(exit).toHaveBeenCalledWith(0);
    });
    expect(logged).toEqual(['updater stopping']);
  });

  it('exits on SIGINT, once only on a second signal', async () => {
    await boot();
    const exit = vi.spyOn(process, 'exit').mockReturnValue(undefined as never);

    signal('SIGINT');
    signal('SIGTERM');

    await vi.waitFor(() => {
      expect(exit).toHaveBeenCalledWith(0);
    });
    expect(exit).toHaveBeenCalledTimes(1);
  });
});
