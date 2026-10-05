import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Db, HealthDocument } from '@zamfono/shared';
import { MIGRATIONS_DIR, seedSettings } from '@zamfono/shared/testDb.js';

import { testKeyring } from '#testing/fixtures.js';
import { asRun, makeTestDb } from '#testing/testDb.js';

import { apiHealth } from '../health.js';
import { runOperation } from '../ops/runner.js';
import type { Actor } from '../ops/types.js';
import { startRelayCheck, type RelayCheck } from './relayCheck.js';
import { forgetRelayOutcomes, relayState } from './relayState.js';

import '../ops/index.js';

vi.mock('pino', () => ({
  default: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() })
}));

const owner: Actor = { id: 'owner-1', name: 'Owner', role: 'owner' };
const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;

const verify = vi.fn<() => Promise<true>>();
let check: RelayCheck | undefined;

async function relayDb(smtpCheckIntervalS: number | null = 60): Promise<Db> {
  const db = await makeTestDb();
  await seedSettings(db, {
    smtpHost: 'smtp.example.test',
    mailFrom: 'no-reply@example.test',
    smtpCheckIntervalS
  });
  return db;
}

function start(db: Db): void {
  check = startRelayCheck({
    db,
    kr: testKeyring(),
    transportFor: () => ({ verify })
  });
}

const checked = (times: number): Promise<void> =>
  vi.waitFor(() => {
    expect(verify).toHaveBeenCalledTimes(times);
  });

const update = (db: Db, patch: Record<string, unknown>): Promise<unknown> =>
  runOperation(db, 'settings.update', patch, asRun({ actor: owner }));

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  forgetRelayOutcomes();
  verify.mockReset().mockResolvedValue(true);
});

afterEach(() => {
  check?.stop();
  vi.useRealTimers();
});

describe('the relay check (§10.2 "Relay check")', () => {
  it('checks at start and every smtp_check_interval_s seconds', async () => {
    start(await relayDb(60));
    await checked(1);
    await vi.waitFor(() => {
      expect(relayState()).toMatchObject({ ok: true });
    });
    await vi.advanceTimersByTimeAsync(MINUTE_MS);
    await checked(2);
    await vi.advanceTimersByTimeAsync(MINUTE_MS);
    await checked(3);
  });

  it('checks only at start with smtp_check_interval_s NULL', async () => {
    start(await relayDb(null));
    await checked(1);
    await vi.advanceTimersByTimeAsync(DAY_MS);
    expect(verify).toHaveBeenCalledTimes(1);
  });

  it('checks nothing while no relay is configured', async () => {
    const db = await makeTestDb();
    await seedSettings(db);
    start(db);
    await vi.advanceTimersByTimeAsync(DAY_MS);
    expect(verify).not.toHaveBeenCalled();
  });

  it('records a failed check by its class', async () => {
    verify.mockRejectedValue(
      Object.assign(new Error('Invalid login: 535'), { code: 'EAUTH' })
    );
    start(await relayDb());
    await vi.waitFor(() => {
      expect(relayState()?.error?.class).toBe('authentication');
    });
  });

  it('checks again at once after a change of the relay, but not of mail_from', async () => {
    const db = await relayDb(null);
    start(db);
    await checked(1);
    await update(db, { mailFrom: 'other@example.test' });
    await vi.advanceTimersByTimeAsync(0);
    expect(verify).toHaveBeenCalledTimes(1);
    await update(db, { smtpPort: 587, smtpSecurity: 'starttls' });
    await checked(2);
  });

  it('checks at once when a change of mail_from configures the relay', async () => {
    const db = await relayDb(null);
    await update(db, { mailFrom: null });
    start(db);
    await vi.advanceTimersByTimeAsync(0);
    expect(verify).not.toHaveBeenCalled();
    await update(db, { mailFrom: 'no-reply@example.test' });
    await checked(1);
  });

  it('times the next check anew after a change of the interval', async () => {
    const db = await relayDb(null);
    start(db);
    await checked(1);
    await update(db, { smtpCheckIntervalS: 60 });
    await vi.advanceTimersByTimeAsync(MINUTE_MS);
    await checked(2);
    await update(db, { smtpCheckIntervalS: null });
    await vi.advanceTimersByTimeAsync(DAY_MS);
    expect(verify).toHaveBeenCalledTimes(2);
  });
});

describe('mail:relay and system.info mail', () => {
  const health = (db: Db): Promise<HealthDocument> =>
    apiHealth({
      db,
      migrationsDir: MIGRATIONS_DIR,
      coreChecks: () => Promise.resolve(null),
      keyring: testKeyring(),
      certificateSync: { state: 'ok', at: null },
      sipBanHelper: { running: true, heartbeat: null },
      mailRelay: relayState()
    });
  const info = async (db: Db): Promise<unknown> =>
    ((await runOperation(db, 'system.info', {}, asRun())) as { mail: unknown })
      .mail;

  it('has neither while no relay is configured', async () => {
    const db = await makeTestDb();
    await seedSettings(db);
    expect((await health(db)).checks['mail:relay']).toBeUndefined();
    await expect(info(db)).resolves.toBeNull();
  });

  it('warns without output before the first outcome', async () => {
    const db = await relayDb();
    expect((await health(db)).checks['mail:relay']).toEqual([
      { status: 'warn' }
    ]);
    await expect(info(db)).resolves.toBeNull();
  });

  it('passes after a success and warns with only the class after a failure', async () => {
    const db = await relayDb(null);
    start(db);
    await checked(1);
    await vi.waitFor(() => {
      expect(relayState()).not.toBeNull();
    });
    const at = relayState()?.at;
    expect((await health(db)).checks['mail:relay']).toEqual([
      { status: 'pass', time: at }
    ]);
    await expect(info(db)).resolves.toEqual({ ok: true, at, error: null });

    verify.mockRejectedValue(
      Object.assign(new Error('connect ECONNREFUSED 192.0.2.1:465'), {
        code: 'ESOCKET',
        syscall: 'connect'
      })
    );
    await update(db, { smtpHost: 'smtp2.example.test' });
    await vi.waitFor(() => {
      expect(relayState()?.ok).toBe(false);
    });
    const failedAt = relayState()?.at;
    expect((await health(db)).checks['mail:relay']).toEqual([
      { status: 'warn', output: 'unreachable', time: failedAt }
    ]);
    await expect(info(db)).resolves.toEqual({
      ok: false,
      at: failedAt,
      error: {
        class: 'unreachable',
        message: 'connect ECONNREFUSED 192.0.2.1:465'
      }
    });
  });
});
