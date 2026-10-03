import { describe, expect, it } from 'vitest';

import { flush } from '../testing/eventually.js';
import { isReloadInProgress, ModuleReloader } from './moduleReloader.js';
import { AriError, type AsteriskModule } from './types.js';

const inProgress = (): AriError =>
  new AriError(409, { message: 'Another reload is currently in progress' });

type Gate = { promise: Promise<void>; open: () => void };

function gate(): Gate {
  let open: () => void = () => undefined;
  const promise = new Promise<void>(resolve => {
    open = resolve;
  });
  return { promise, open };
}

/** A fake Asterisk: one reload at a time, refusing any that overlaps, like `ast_module_reload`. */
function fakeAsterisk(): {
  reloadOnce: (module: AsteriskModule) => Promise<void>;
  started: AsteriskModule[];
  release: () => void;
} {
  const started: AsteriskModule[] = [];
  let running: Gate | null = null;
  return {
    started,
    reloadOnce: async module => {
      if (running) {
        throw inProgress();
      }
      started.push(module);
      const current = gate();
      running = current;
      await current.promise;
    },
    release: () => {
      const current = running;
      running = null;
      current?.open();
    }
  };
}

describe('ModuleReloader (§3.1 config propagation)', () => {
  it('runs reloads one after another, never side by side', async () => {
    const asterisk = fakeAsterisk();
    const reloader = new ModuleReloader(asterisk.reloadOnce, { wait: flush });
    const all = Promise.all([
      reloader.reload('res_pjsip'),
      reloader.reload('pbx_config'),
      reloader.reload('res_musiconhold')
    ]);
    await flush();
    expect(asterisk.started).toEqual(['res_pjsip']);
    asterisk.release();
    await flush();
    expect(asterisk.started).toEqual(['res_pjsip', 'pbx_config']);
    asterisk.release();
    await flush();
    asterisk.release();
    await all;
    expect(asterisk.started).toEqual([
      'res_pjsip',
      'pbx_config',
      'res_musiconhold'
    ]);
  });

  it('joins a waiting reload of the same module, but queues a fresh one behind a running one', async () => {
    const asterisk = fakeAsterisk();
    const reloader = new ModuleReloader(asterisk.reloadOnce, { wait: flush });
    const first = reloader.reload('res_pjsip');
    await flush();
    // The running reload may have read the files before these writes: one more must follow.
    const second = reloader.reload('res_pjsip');
    const third = reloader.reload('res_pjsip');
    asterisk.release();
    await first;
    await flush();
    asterisk.release();
    await Promise.all([second, third]);
    expect(asterisk.started).toEqual(['res_pjsip', 'res_pjsip']);
  });

  it('retries a reload Asterisk refuses because another one is running', async () => {
    const waits: number[] = [];
    let calls = 0;
    const reloader = new ModuleReloader(
      () => {
        calls += 1;
        return calls < 3 ? Promise.reject(inProgress()) : Promise.resolve();
      },
      {
        retryDelaysMs: [10, 20, 40],
        wait: ms => {
          waits.push(ms);
          return Promise.resolve();
        }
      }
    );
    await reloader.reload('res_pjsip');
    expect(calls).toBe(3);
    expect(waits).toEqual([10, 20]);
  });

  it('gives up once the retries run out, and keeps serving later reloads', async () => {
    let refuse = true;
    const reloader = new ModuleReloader(
      () => (refuse ? Promise.reject(inProgress()) : Promise.resolve()),
      { retryDelaysMs: [1, 1], wait: () => Promise.resolve() }
    );
    await expect(reloader.reload('pbx_config')).rejects.toBeInstanceOf(
      AriError
    );
    refuse = false;
    await expect(reloader.reload('pbx_config')).resolves.toBeUndefined();
  });

  it('does not retry any other failure', async () => {
    let calls = 0;
    const reloader = new ModuleReloader(
      () => {
        calls += 1;
        return Promise.reject(
          new AriError(409, { message: 'Module could not be reloaded' })
        );
      },
      { wait: () => Promise.resolve() }
    );
    await expect(reloader.reload('res_pjsip')).rejects.toBeInstanceOf(AriError);
    expect(calls).toBe(1);
  });

  it('recognises only the in-progress refusal', () => {
    expect(isReloadInProgress(inProgress())).toBe(true);
    expect(
      isReloadInProgress(new AriError(409, { message: 'Module not found' }))
    ).toBe(false);
    expect(isReloadInProgress(new AriError(500, {}))).toBe(false);
    expect(isReloadInProgress(new Error('in progress'))).toBe(false);
  });
});
