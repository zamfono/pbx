import process from 'node:process';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Db } from '@zamfono/shared';

import type { Bus } from './lib/jobs/backup.js';
import { scheduleBackups } from './lib/jobs/cron.js';
import { scheduleRetention } from './lib/jobs/retention.js';
import { propagateAtBoot } from './lib/propagation.js';
import type { Keyring } from './lib/secretbox.js';
import { seedIfEmpty } from './lib/seed.js';
import { execCommand, startBootJobs } from './server.js';

vi.mock('./lib/seed.js', () => ({
  seedIfEmpty: vi.fn(() => Promise.resolve('seeded'))
}));
vi.mock('./lib/jobs/retention.js', () => ({
  scheduleRetention: vi.fn(() => ({ stop: vi.fn() }))
}));
vi.mock('./lib/jobs/cron.js', () => ({ scheduleBackups: vi.fn() }));
vi.mock('./lib/propagation.js', () => ({
  propagateAtBoot: vi.fn(() => Promise.resolve())
}));

const FAKE_DB = {} as unknown as Db;
const FAKE_KR = {} as unknown as Keyring;
const FAKE_BUS: Bus = {
  publish: () => undefined,
  enqueue: () => Promise.resolve()
};

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

describe('startBootJobs', () => {
  beforeEach(() => {
    vi.mocked(seedIfEmpty).mockClear();
    vi.mocked(scheduleRetention).mockClear();
    vi.mocked(scheduleBackups).mockClear();
    vi.mocked(propagateAtBoot).mockClear();
  });

  it('runs the first-boot seed, so a fresh stack has an owner before it serves', async () => {
    await startBootJobs(FAKE_DB, FAKE_KR, FAKE_BUS);

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

    await startBootJobs(FAKE_DB, FAKE_KR, FAKE_BUS);

    expect(order).toEqual(['seed', 'render']);
    expect(vi.mocked(propagateAtBoot).mock.calls[0]?.[0]).toBe(FAKE_DB);
  });

  it('schedules the daily retention purge', async () => {
    await startBootJobs(FAKE_DB, FAKE_KR, FAKE_BUS);

    expect(scheduleRetention).toHaveBeenCalledTimes(1);
    expect(vi.mocked(scheduleRetention).mock.calls[0]?.[0]).toBe(FAKE_DB);
  });

  it('schedules backups', async () => {
    await startBootJobs(FAKE_DB, FAKE_KR, FAKE_BUS);

    expect(scheduleBackups).toHaveBeenCalledTimes(1);
  });

  it('rejects when the seed fails, so a half-seeded stack never starts serving', async () => {
    vi.mocked(seedIfEmpty).mockRejectedValueOnce(new Error('seed failed'));

    await expect(startBootJobs(FAKE_DB, FAKE_KR, FAKE_BUS)).rejects.toThrow(
      'seed failed'
    );
    expect(scheduleRetention).not.toHaveBeenCalled();
    expect(propagateAtBoot).not.toHaveBeenCalled();
  });
});
