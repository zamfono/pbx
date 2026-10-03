import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, onTestFinished } from 'vitest';

import { createRunner, HOST_RUN_STALE_MS, loadState } from './runner.js';

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'zamfono-updater-'));
  onTestFinished(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

/**
 * A stand-in for update.sh, where the runner runs it, in the project's directory: it prints what
 * it was given and exits with `code`.
 */
async function fakeScript(dir: string, code: number): Promise<void> {
  await writeFile(
    path.join(dir, 'update.sh'),
    `echo "args=$*"\necho "updater=$ZAMFONO_UPDATER project=$COMPOSE_PROJECT_NAME host=$DOCKER_HOST"\nexit ${code}\n`
  );
}

function project(workingDir: string): { name: string; workingDir: string } {
  return { name: 'zamfono', workingDir };
}

describe('createRunner', () => {
  it('runs update.sh with the Compose project and records the success', async () => {
    const stackDir = await tempDir();
    const runner = await createRunner({
      stackDir,
      project: project(stackDir),
      socketPath: '/var/run/docker.sock'
    });
    await fakeScript(stackDir, 0);
    const { finished } = await runner.start('0.0.6', '0.0.7', {
      trigger: 'manual'
    });
    expect(runner.current()).toMatchObject({ state: 'running', to: '0.0.7' });
    await finished;
    expect(runner.current()).toMatchObject({
      state: 'succeeded',
      from: '0.0.6',
      to: '0.0.7'
    });
    const logText = await readFile(
      path.join(stackDir, '.update', 'update.log'),
      'utf8'
    );
    expect(logText).toContain('args=0.0.7');
    expect(logText).toContain(
      'updater=1 project=zamfono host=unix:///var/run/docker.sock'
    );
    expect((await loadState(stackDir)).state).toBe('succeeded');
  });

  it('keeps who asked for the run in its record', async () => {
    const stackDir = await tempDir();
    const runner = await createRunner({
      stackDir,
      project: project(stackDir),
      socketPath: '/s'
    });
    await fakeScript(stackDir, 0);
    const { finished } = await runner.start('0.0.6', '0.0.7', {
      trigger: 'automatic'
    });
    expect(runner.current()).toMatchObject({ trigger: 'automatic' });
    await finished;
    expect(await loadState(stackDir)).toMatchObject({
      state: 'succeeded',
      trigger: 'automatic'
    });
  });

  it('records a failure with the end of the log', async () => {
    const stackDir = await tempDir();
    const runner = await createRunner({
      stackDir,
      project: project(stackDir),
      socketPath: '/s'
    });
    await fakeScript(stackDir, 1);
    const { finished } = await runner.start('0.0.6', '0.0.7', {
      trigger: 'manual'
    });
    await finished;
    expect(runner.current().state).toBe('failed');
    expect(runner.current().error).toContain('args=0.0.7');
  });

  it("reports a run update.sh recorded on the host since the updater's own", async () => {
    const stackDir = await tempDir();
    const runner = await createRunner({
      stackDir,
      project: project(stackDir),
      socketPath: '/s'
    });
    await fakeScript(stackDir, 0);
    const { finished } = await runner.start('0.0.6', '0.0.7', {
      trigger: 'manual'
    });
    await finished;
    const hostRun = {
      state: 'succeeded',
      from: '0.0.7',
      to: '0.1.0',
      startedAt: '2026-10-01T10:00:00.000Z',
      finishedAt: '2026-10-01T10:02:00.000Z'
    };
    await writeFile(
      path.join(stackDir, '.update', 'state.json'),
      `${JSON.stringify(hostRun, null, 2)}\n`
    );

    expect(runner.current()).toEqual(hostRun);
  });
});

describe('loadState', () => {
  it('marks a run the updater did not see end as interrupted', async () => {
    const stackDir = await tempDir();
    const runner = await createRunner({
      stackDir,
      project: project(stackDir),
      socketPath: '/s'
    });
    await fakeScript(stackDir, 0);
    const { finished } = await runner.start('0.0.6', '0.0.7', {
      trigger: 'manual'
    });
    // Read back before the child ends, as a restarted updater would find it.
    const state = await loadState(stackDir);
    expect(state).toMatchObject({ state: 'failed', to: '0.0.7' });
    expect(state.error).toContain('interrupted');
    await finished;
  });

  it('leaves a running host run alone, unless it started HOST_RUN_STALE_MS ago', async () => {
    const stackDir = await tempDir();
    const hostRun = {
      state: 'running',
      from: '0.1.0',
      to: '0.1.1',
      trigger: 'host',
      startedAt: '2026-10-01T03:00:00.000Z'
    };
    await mkdir(path.join(stackDir, '.update'));
    await writeFile(
      path.join(stackDir, '.update', 'state.json'),
      `${JSON.stringify(hostRun, null, 2)}\n`
    );
    const startedMs = Date.parse(hostRun.startedAt);
    const at = (ms: number) => () => new Date(startedMs + ms).toISOString();

    expect(await loadState(stackDir, at(HOST_RUN_STALE_MS - 1))).toEqual(
      hostRun
    );
    const stale = await loadState(stackDir, at(HOST_RUN_STALE_MS));
    expect(stale).toMatchObject({ state: 'failed', trigger: 'host' });
    expect(stale.error).toContain('update.sh on the host');
  });

  it('starts idle in a directory that never ran an update', async () => {
    expect(await loadState(await tempDir())).toEqual({ state: 'idle' });
  });
});
