import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import type { Db, ReloadKind } from '@zamfono/shared';
import { MIGRATIONS_DIR } from '@zamfono/shared/testDb.js';

import { getCoreClient, type CoreClient } from './coreClient.js';
import { stubCoreClient } from './coreClientStub.js';
import { apiHealth } from './health.js';
import { renderMetrics } from './metrics.js';
import { onceConfigPropagated, runAfterCommit } from './ops/afterCommit.js';
import { newEffects } from './ops/effects.js';
import { register } from './ops/registry.js';
import {
  afterCommit,
  afterPropagation,
  propagate,
  runOperation
} from './ops/runner.js';
import { defineOperation } from './ops/types.js';
import { propagateConfig } from './propagation.js';
import { isPropagationPending } from './propagationPending.js';
import { keyringFromEnv } from './secretbox.js';
import { makeTestDb, seedTenantTimeZone } from './testDb.js';

// The propagation under test, not the setup file's stand-in for it.
vi.unmock('./propagation.js');

process.env.SECRETBOX_KEY = `1:${Buffer.alloc(32, 7).toString('base64')}`;
const kr = keyringFromEnv(process.env);

/** `core` as the test sets it: up or down, and every `configChanged` it was asked for. */
const core = { up: true, reloads: [] as ReloadKind[][] };

function coreClient(): CoreClient {
  return stubCoreClient({
    configChanged: kinds => {
      core.reloads.push(kinds);
      return core.up
        ? Promise.resolve()
        : Promise.reject(new Error('core unreachable'));
    }
  });
}

const dirs: string[] = [];

/** A database whose propagations render into a directory of their own and reach `core`. */
async function setUp(): Promise<Db> {
  const db = await makeTestDb();
  await seedTenantTimeZone(db, 'UTC');
  const genDir = await mkdtemp(path.join(tmpdir(), 'zamfono-gen-'));
  dirs.push(genDir);
  process.env.ASTERISK_GEN_DIR = genDir;
  vi.mocked(getCoreClient).mockReturnValue(coreClient());
  return db;
}

beforeEach(() => {
  core.up = true;
  core.reloads = [];
});

afterEach(async () => {
  vi.useRealTimers();
  vi.mocked(getCoreClient).mockReset();
  delete process.env.ASTERISK_GEN_DIR;
  await Promise.all(
    dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))
  );
});

// §3.1 "Config propagation": a failed propagation is owed until one succeeds.
describe('an owed config propagation', () => {
  it('is shown by /healthz and /metrics until a propagation succeeds, which reloads every module', async () => {
    const db = await setUp();
    core.up = false;
    await expect(propagateConfig(db, [])).rejects.toThrow('core unreachable');

    expect(await isPropagationPending(db)).toBe(true);
    const health = await apiHealth({
      db,
      migrationsDir: MIGRATIONS_DIR,
      checkCore: () => Promise.resolve({ reachable: false, ari: false }),
      keyring: kr,
      certificateSync: 'unknown'
    });
    expect(health.configPropagationPending).toBe(true);
    const metrics = await renderMetrics({
      db,
      dbFile: ':memory:',
      checkAri: () => Promise.resolve(false),
      coreState: () => Promise.reject(new Error('core unreachable')),
      certSyncStatus: () => 'unknown',
      version: { version: 'dev', revision: '', display: 'dev' }
    });
    expect(metrics).toContain('zamfono_config_propagation_pending 1');
    expect(metrics).toContain('zamfono_config_propagation_failures_total 1');

    core.up = true;
    await propagateConfig(db, []);
    expect(core.reloads).toEqual([[], ['pjsip', 'dialplan', 'moh']]);
    expect(await isPropagationPending(db)).toBe(false);
  });

  it('is retried on its own, and then runs what waited for it', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const db = await setUp();
    core.up = false;
    await expect(propagateConfig(db, ['pjsip'])).rejects.toThrow(
      'core unreachable'
    );
    const ran: string[] = [];
    let waited: () => void = () => undefined;
    const done = new Promise<void>(resolve => {
      waited = resolve;
    });
    const warnings = await runAfterCommit(
      db,
      {
        ...newEffects(),
        after: [
          {
            hook: () => {
              ran.push('ringotel');
              waited();
              return Promise.resolve(null);
            },
            waitsForAsterisk: true
          },
          {
            hook: () => {
              ran.push('mail');
              return Promise.resolve(null);
            },
            waitsForAsterisk: false
          }
        ]
      },
      'core unreachable'
    );
    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toContain('core unreachable');
    expect(ran).toEqual(['mail']);

    core.up = true;
    await vi.advanceTimersByTimeAsync(5000);
    await done;
    expect(ran).toEqual(['mail', 'ringotel']);
    expect(core.reloads.at(-1)).toEqual(['pjsip', 'dialplan', 'moh']);
    expect(await isPropagationPending(db)).toBe(false);
  });

  it('holds a step outside any operation until it succeeds', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const db = await setUp();
    core.up = false;
    await expect(propagateConfig(db, [])).rejects.toThrow('core unreachable');
    let ran = false;
    let waited: () => void = () => undefined;
    const done = new Promise<void>(resolve => {
      waited = resolve;
    });
    await onceConfigPropagated(db, () => {
      ran = true;
      waited();
      return Promise.resolve();
    });
    expect(ran).toBe(false);

    core.up = true;
    await vi.advanceTimersByTimeAsync(5000);
    await done;
    expect(ran).toBe(true);
    expect(await isPropagationPending(db)).toBe(false);
  });

  it('answers the write with a warning, holds its Ringotel step and runs it after the next write propagates', async () => {
    const db = await setUp();
    const ran: string[] = [];
    register(
      defineOperation({
        name: 'test.owedWrite',
        description:
          'a write with a step after the commit and one after Asterisk holds it',
        input: z.object({ label: z.string() }),
        minRole: 'admin',
        entity: () => ({ kind: 'device', id: 'd1' }),
        run: (ctx, input) => {
          propagate(ctx, ['pjsip']);
          afterCommit(ctx, () => {
            ran.push(`commit ${input.label}`);
            return Promise.resolve(null);
          });
          afterPropagation(ctx, () => {
            ran.push(`asterisk ${input.label}`);
            return Promise.resolve(null);
          });
          return Promise.resolve({ ok: true });
        }
      })
    );
    const run = {
      actor: { id: 'owner', name: 'Owner', role: 'owner' as const },
      channel: 'rest' as const,
      requestId: 'req-1'
    };

    core.up = false;
    const first = (await runOperation(
      db,
      'test.owedWrite',
      { label: 'first' },
      run
    )) as { warnings?: string[] };
    expect(first.warnings?.[0]).toBe(
      'the change is stored but has not reached Asterisk (core unreachable); api retries it until it does'
    );
    expect(ran).toEqual(['commit first']);

    core.up = true;
    const second = (await runOperation(
      db,
      'test.owedWrite',
      { label: 'second' },
      run
    )) as { warnings?: string[] };
    expect(second.warnings).toBeUndefined();
    expect(ran).toEqual([
      'commit first',
      'asterisk first',
      'commit second',
      'asterisk second'
    ]);
    expect(await isPropagationPending(db)).toBe(false);
  });
});
