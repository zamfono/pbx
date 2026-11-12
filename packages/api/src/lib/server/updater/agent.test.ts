import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { describe, expect, it } from 'vitest';

import { AgentRefusal, createAgent } from './agent.js';
import { RUN_STALE_MS } from './record.js';

/** A stack directory with the `.update/requests` the agent and `api` share. */
async function stackDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'agent-'));
  await mkdir(path.join(dir, '.update', 'requests'), { recursive: true });
  return dir;
}

const request = (dir: string): string =>
  path.join(dir, '.update', 'requests', 'request');

/** Takes the request as the host agent would, once it appears, answers its id with `reason`
 * as a refusal or else ok, and keeps what it read. */
async function takeOnce(dir: string, reason?: string): Promise<string> {
  for (;;) {
    // eslint-disable-next-line no-await-in-loop -- waiting for the request to appear
    const text = await readFile(request(dir), 'utf8').catch(() => undefined);
    if (text !== undefined) {
      // eslint-disable-next-line no-await-in-loop -- see above
      await rm(request(dir));
      const id = /^id=(?<id>.*)$/mu.exec(text)?.groups?.id;
      // eslint-disable-next-line no-await-in-loop -- see above
      await writeFile(
        path.join(dir, '.update', 'result'),
        JSON.stringify({ id, ok: reason === undefined, reason })
      );
      return text;
    }
    // eslint-disable-next-line no-await-in-loop -- see above
    await sleep(20);
  }
}

describe('the host agent, from api', () => {
  it('is present once it has run and reported the stack directory', async () => {
    const dir = await stackDir();
    const agent = createAgent(path.join(dir, '.update'));
    expect(await agent.present()).toBe(false);
    await writeFile(
      path.join(dir, '.update', 'agent'),
      '2026-11-12T10:00:00.000Z\n'
    );
    expect(await agent.present()).toBe(false);
    await writeFile(
      path.join(dir, '.update', 'stack.json'),
      '{ "current": "0.9.1" }\n'
    );
    expect(await agent.present()).toBe(true);
  });

  it('leaves a request of key=value lines with an id, and resolves once the agent answered it', async () => {
    const dir = await stackDir();
    const taken = takeOnce(dir);
    await createAgent(path.join(dir, '.update')).send(
      {
        action: 'update',
        version: '0.9.0',
        breaking: false,
        requester: { trigger: 'manual', by: 'Olga Owner' }
      },
      Date.now() + 5000
    );
    expect(await taken).toMatch(
      /^id=[0-9a-f-]{36}\naction=update\nversion=0\.9\.0\nbreaking=false\ntrigger=manual\nby=Olga Owner\n$/u
    );
  });

  it('places no request whose time ran out while it waited its turn', async () => {
    const dir = await stackDir();
    const late = createAgent(path.join(dir, '.update')).send(
      { action: 'reboot' },
      Date.now() + 500
    );
    await expect(late).rejects.toMatchObject({ reason: 'notTaken' });
    await expect(stat(request(dir))).rejects.toThrow();
  });

  it('sends one request at a time, each getting its own answer', async () => {
    const dir = await stackDir();
    const agent = createAgent(path.join(dir, '.update'));
    // The agent takes and answers two requests, one after the other.
    const taken = (async () => [await takeOnce(dir), await takeOnce(dir)])();
    await Promise.all([
      agent.send({ action: 'report' }, Date.now() + 5000),
      agent.send({ action: 'updates', enabled: true }, Date.now() + 5000)
    ]);
    const [first, second] = await taken;
    expect(first).toContain('action=report');
    expect(second).toContain('action=updates');
  });

  it("passes the agent's refusal on, with its reason", async () => {
    const dir = await stackDir();
    const taken = takeOnce(dir, 'HOST_CONTROL is not true in .env');
    const refusal = createAgent(path.join(dir, '.update')).send(
      { action: 'reboot' },
      Date.now() + 5000
    );
    await expect(refusal).rejects.toMatchObject({
      reason: 'refused',
      message: 'the host agent refused: HOST_CONTROL is not true in .env'
    });
    await taken;
  });

  it('waits for the answer to its own request alone, not to an earlier one', async () => {
    const dir = await stackDir();
    await writeFile(
      path.join(dir, '.update', 'result'),
      JSON.stringify({ id: 'an-earlier-one', ok: true })
    );
    // The agent takes the request but never answers it.
    const taken = (async () => {
      for (;;) {
        // eslint-disable-next-line no-await-in-loop -- waiting for the request to appear
        const removed = await rm(request(dir)).then(
          () => true,
          () => false
        );
        if (removed) {
          return;
        }
        // eslint-disable-next-line no-await-in-loop -- see above
        await sleep(20);
      }
    })();
    const refusal = createAgent(path.join(dir, '.update')).send(
      { action: 'report' },
      Date.now() + 1500
    );
    await expect(refusal).rejects.toMatchObject({ reason: 'notTaken' });
    await expect(refusal).rejects.toThrow('did not answer');
    await taken;
  });

  it('refuses a second request while one waits, and takes back one the agent did not take', async () => {
    const dir = await stackDir();
    await writeFile(request(dir), 'action=reboot\n');
    const agent = createAgent(path.join(dir, '.update'));
    await expect(
      agent.send({ action: 'reboot' }, Date.now() + 1500)
    ).rejects.toMatchObject({
      reason: 'pending'
    });
    await rm(request(dir));
    const refusal = agent.send(
      { action: 'updates', enabled: true },
      Date.now() + 1500
    );
    await expect(refusal).rejects.toBeInstanceOf(AgentRefusal);
    await expect(refusal).rejects.toMatchObject({ reason: 'notTaken' });
    await expect(stat(request(dir))).rejects.toThrow();
  });

  it("reads the run's record and the host's report, a long-running run as cut off", async () => {
    const dir = await stackDir();
    const now = Date.parse('2026-11-12T12:00:00Z');
    const agent = createAgent(path.join(dir, '.update'), { now: () => now });
    expect(agent.state()).toEqual({ state: 'idle' });
    expect(await agent.host()).toBeUndefined();
    const record = (startedAt: string): Promise<void> =>
      writeFile(
        path.join(dir, '.update', 'state.json'),
        JSON.stringify({
          state: 'running',
          to: '0.9.0',
          trigger: 'automatic',
          startedAt
        })
      );
    await record(new Date(now - 60_000).toISOString());
    expect(agent.state()).toMatchObject({ state: 'running' });
    await record(new Date(now - RUN_STALE_MS).toISOString());
    expect(agent.state()).toMatchObject({
      state: 'failed',
      error: 'interrupted: the update did not finish on the host'
    });
    await writeFile(
      path.join(dir, '.update', 'host.json'),
      '{ "rebootRequired": null, "updates": true }\n'
    );
    expect(await agent.host()).toEqual({ rebootRequired: null, updates: true });
  });
});
