import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { createRunner, HOST_RUN_STALE_MS, loadState } from './runner.js';

async function tempDir(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), 'zamfono-updater-'));
}

/** A stand-in for update.sh that prints what it was given and exits with `code`. */
async function fakeScript(dir: string, code: number): Promise<string> {
  const script = path.join(dir, 'update.sh');
  await writeFile(
    script,
    `echo "args=$*"\necho "updater=$ZAMFONO_UPDATER files=$ZAMFONO_COMPOSE_FILES project=$COMPOSE_PROJECT_NAME host=$DOCKER_HOST"\nexit ${code}\n`
  );
  return script;
}

function project(workingDir: string): {
  name: string;
  workingDir: string;
  configFiles: string[];
} {
  return {
    name: 'zamfono',
    workingDir,
    configFiles: [
      `${workingDir}/compose.yaml`,
      `${workingDir}/compose.ports.yaml`
    ]
  };
}

describe('createRunner', () => {
  it('runs update.sh with the Compose project and records the success', async () => {
    const stackDir = await tempDir();
    const runner = await createRunner({
      stackDir,
      project: project(stackDir),
      socketPath: '/var/run/docker.sock',
      script: await fakeScript(stackDir, 0)
    });
    await runner.start('0.0.6', '0.0.7');
    expect(runner.current()).toMatchObject({ state: 'running', to: '0.0.7' });
    await runner.settled();
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
      `updater=1 files=${stackDir}/compose.yaml ${stackDir}/compose.ports.yaml project=zamfono host=unix:///var/run/docker.sock`
    );
    expect((await loadState(stackDir)).state).toBe('succeeded');
  });

  it('keeps who asked for the run in its record', async () => {
    const stackDir = await tempDir();
    const runner = await createRunner({
      stackDir,
      project: project(stackDir),
      socketPath: '/s',
      script: await fakeScript(stackDir, 0)
    });
    await runner.start('0.0.6', '0.0.7', { trigger: 'automatic' });
    expect(runner.current()).toMatchObject({ trigger: 'automatic' });
    await runner.settled();
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
      socketPath: '/s',
      script: await fakeScript(stackDir, 1)
    });
    await runner.start('0.0.6', '0.0.7');
    await runner.settled();
    expect(runner.current().state).toBe('failed');
    expect(runner.current().error).toContain('args=0.0.7');
  });

  it("reports a run update.sh recorded on the host since the updater's own", async () => {
    const stackDir = await tempDir();
    const runner = await createRunner({
      stackDir,
      project: project(stackDir),
      socketPath: '/s',
      script: await fakeScript(stackDir, 0)
    });
    await runner.start('0.0.6', '0.0.7');
    await runner.settled();
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
      socketPath: '/s',
      script: await fakeScript(stackDir, 0)
    });
    await runner.start('0.0.6', '0.0.7');
    // Read back before the child ends, as a restarted updater would find it.
    const state = await loadState(stackDir);
    expect(state).toMatchObject({ state: 'failed', to: '0.0.7' });
    expect(state.error).toContain('interrupted');
    await runner.settled();
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
