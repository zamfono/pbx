import process from 'node:process';
import pino from 'pino';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Db } from '@zamfono/shared';

import { connectCoreEvents } from '../coreEvents.js';
import { propagateAtBoot } from '../propagation.js';
import type { Keyring } from '../secretbox.js';
import { seedIfEmpty } from '../seed.js';
import { scheduleAutoUpdate } from './autoUpdate.js';
import {
  execCommand,
  runBootSteps,
  startBackgroundJobs
} from './background.js';
import { startCertSync } from './certSync.js';
import { scheduleBackups } from './cron.js';
import { reencryptSweep } from './keyRotation.js';
import { scheduleRetention } from './retention.js';

vi.mock('../seed.js', () => ({
  seedIfEmpty: vi.fn(() => Promise.resolve('seeded'))
}));
vi.mock('../seedBackupTarget.js', () => ({
  seedBackupTarget: vi.fn(() => Promise.resolve('skipped'))
}));
vi.mock('../propagation.js', () => ({
  propagateAtBoot: vi.fn(() => Promise.resolve())
}));
vi.mock('./keyRotation.js', () => ({
  reencryptSweep: vi.fn(() => Promise.resolve({ reencrypted: 0, remaining: 0 }))
}));
vi.mock('./retention.js', () => ({
  scheduleRetention: vi.fn(() => ({ stop: vi.fn() }))
}));
vi.mock('./cron.js', () => ({
  scheduleBackups: vi.fn(() => ({ enqueue: vi.fn(), stop: vi.fn() }))
}));
vi.mock('./autoUpdate.js', () => ({
  scheduleAutoUpdate: vi.fn(() => ({ stop: vi.fn() }))
}));
vi.mock('./certSync.js', () => ({
  startCertSync: vi.fn(() => ({
    status: vi.fn(),
    notify: vi.fn(),
    stop: vi.fn()
  }))
}));
vi.mock('../coreEvents.js', () => ({
  connectCoreEvents: vi.fn(() => ({ close: vi.fn() }))
}));

const FAKE_DB = {} as unknown as Db;
const FAKE_KR = {} as unknown as Keyring;
const log = pino({ level: 'silent' });

describe('execCommand', () => {
  it('runs a command and returns its stdout', async () => {
    const { stdout } = await execCommand('echo', ['hello'], {
      env: process.env
    });
    expect(stdout.trim()).toBe('hello');
  });

  it('writes `input` to the child process stdin', async () => {
    const { stdout } = await execCommand('cat', [], {
      env: process.env,
      input: 'zamfono-backup-secret'
    });
    expect(stdout).toBe('zamfono-backup-secret');
  });

  it('rejects on a non-zero exit', async () => {
    await expect(
      execCommand('sh', ['-c', 'exit 1'], { env: process.env })
    ).rejects.toThrow();
  });
});

describe('runBootSteps', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('runs the first-boot seed, so a fresh stack has an owner before it serves', async () => {
    await runBootSteps(FAKE_DB, FAKE_KR, log);

    expect(seedIfEmpty).toHaveBeenCalledTimes(1);
    expect(vi.mocked(seedIfEmpty).mock.calls[0]?.[0]).toBe(FAKE_DB);
  });

  // The seed writes parking slots and hold music the rendered hints and MoH files must carry, and
  // an upgrade leaves the previous release's render on the volume (§3.1, §9.1).
  it('renders the Asterisk configuration once, after the seed', async () => {
    const order: string[] = [];
    vi.mocked(seedIfEmpty).mockImplementationOnce(() => {
      order.push('seed');
      return Promise.resolve('seeded');
    });
    vi.mocked(propagateAtBoot).mockImplementationOnce(() => {
      order.push('render');
      return Promise.resolve();
    });

    await runBootSteps(FAKE_DB, FAKE_KR, log);

    expect(order).toEqual(['seed', 'render']);
    expect(vi.mocked(propagateAtBoot).mock.calls[0]?.[0]).toBe(FAKE_DB);
  });
});

describe('startBackgroundJobs', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('starts every recurring job once, after the seed and the key-rotation sweep', async () => {
    const order: string[] = [];
    vi.mocked(seedIfEmpty).mockImplementationOnce(() => {
      order.push('seed');
      return Promise.resolve('seeded');
    });
    vi.mocked(reencryptSweep).mockImplementationOnce(() => {
      order.push('sweep');
      return Promise.resolve({ reencrypted: 0, remaining: 0 });
    });
    vi.mocked(scheduleBackups).mockImplementationOnce(() => {
      order.push('backups');
      return { enqueue: vi.fn(), stop: vi.fn() };
    });

    await startBackgroundJobs(FAKE_DB, FAKE_KR, log);

    expect(order).toEqual(['seed', 'sweep', 'backups']);
    expect(scheduleBackups).toHaveBeenCalledTimes(1);
    expect(scheduleRetention).toHaveBeenCalledTimes(1);
    expect(vi.mocked(scheduleRetention).mock.calls[0]?.[0]).toBe(FAKE_DB);
    expect(startCertSync).toHaveBeenCalledTimes(1);
    expect(scheduleAutoUpdate).toHaveBeenCalledTimes(1);
    expect(connectCoreEvents).toHaveBeenCalledTimes(1);
  });

  it('stops every recurring job on stop()', async () => {
    const jobs = await startBackgroundJobs(FAKE_DB, FAKE_KR, log);

    jobs.stop();

    const stopped = [
      vi.mocked(scheduleBackups).mock.results[0]?.value,
      vi.mocked(scheduleRetention).mock.results[0]?.value,
      vi.mocked(startCertSync).mock.results[0]?.value,
      vi.mocked(scheduleAutoUpdate).mock.results[0]?.value,
      vi.mocked(connectCoreEvents).mock.results[0]?.value
    ] as ({ stop?: () => void; close?: () => void } | undefined)[];
    for (const job of stopped) {
      expect(job?.stop ?? job?.close).toHaveBeenCalledOnce();
    }
  });

  it('lets requests through when the key-rotation sweep throws', async () => {
    vi.mocked(reencryptSweep).mockRejectedValueOnce(new Error('sweep failed'));

    await expect(
      startBackgroundJobs(FAKE_DB, FAKE_KR, log)
    ).resolves.toBeDefined();
    expect(scheduleBackups).toHaveBeenCalledTimes(1);
  });

  it('rejects when the seed fails, so a half-seeded stack never starts serving', async () => {
    vi.mocked(seedIfEmpty).mockRejectedValueOnce(new Error('seed failed'));

    await expect(startBackgroundJobs(FAKE_DB, FAKE_KR, log)).rejects.toThrow(
      'seed failed'
    );
    expect(scheduleRetention).not.toHaveBeenCalled();
    expect(scheduleBackups).not.toHaveBeenCalled();
    expect(propagateAtBoot).not.toHaveBeenCalled();
  });
});
