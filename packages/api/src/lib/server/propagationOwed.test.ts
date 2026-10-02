import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import type { Db, ReloadKind } from '@zamfono/shared';

import type { CoreClient } from './coreClient.js';
import { apiHealth } from './health.js';
import { renderMetrics, resetMetricsAccumulators } from './metrics.js';
import { runAfterCommit } from './ops/afterCommit.js';
import { newEffects } from './ops/effects.js';
import { register } from './ops/registry.js';
import {
  afterCommit,
  afterPropagation,
  onPropagate,
  propagate,
  runOperation
} from './ops/runner.js';
import { defineOperation } from './ops/types.js';
import { propagateConfig, type PropagationDeps } from './propagation.js';
import { isPropagationPending } from './propagationPending.js';
import { keyringFromEnv } from './secretbox.js';
import { makeTestDb, seedTenantTimeZone } from './testDb.js';

const kr = keyringFromEnv({
  SECRETBOX_KEY: `1:${Buffer.alloc(32, 7).toString('base64')}`
});

/** `core` as the test sets it: up or down, and every `configChanged` it was asked for. */
const core = { up: true, reloads: [] as ReloadKind[][] };

function coreClient(): CoreClient {
  const unused = (): Promise<never> => Promise.reject(new Error('not used'));
  return {
    configChanged: (kinds: ReloadKind[]) => {
      core.reloads.push(kinds);
      return core.up
        ? Promise.resolve()
        : Promise.reject(new Error('core unreachable'));
    },
    state: unused,
    originate: unused,
    transfer: unused,
    pickup: unused,
    hangup: unused,
    park: unused,
    parked: unused,
    mwi: unused
  };
}

const dirs: string[] = [];

async function setUp(): Promise<{ db: Db; deps: PropagationDeps }> {
  const db = await makeTestDb();
  await seedTenantTimeZone(db, 'UTC');
  const genDir = await mkdtemp(path.join(tmpdir(), 'zamfono-gen-'));
  dirs.push(genDir);
  return { db, deps: { kr, coreClient: coreClient(), genDir } };
}

beforeEach(() => {
  core.up = true;
  core.reloads = [];
});

afterEach(async () => {
  vi.useRealTimers();
  resetMetricsAccumulators();
  await Promise.all(
    dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))
  );
});

// §3.1 "Config propagation": a failed propagation is owed until one succeeds.
describe('an owed config propagation', () => {
  it('is shown by /healthz and /metrics until a propagation succeeds, which reloads every module', async () => {
    const { db, deps } = await setUp();
    core.up = false;
    await expect(propagateConfig(db, [], deps)).rejects.toThrow(
      'core unreachable'
    );

    expect(await isPropagationPending(db)).toBe(true);
    const health = await apiHealth({
      db,
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
    await propagateConfig(db, [], deps);
    expect(core.reloads).toEqual([[], ['pjsip', 'dialplan', 'moh']]);
    expect(await isPropagationPending(db)).toBe(false);
  });

  it('is retried on its own, and then runs what waited for it', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { db, deps } = await setUp();
    core.up = false;
    await expect(propagateConfig(db, ['pjsip'], deps)).rejects.toThrow(
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

  it('answers the write with a warning, holds its Ringotel step and runs it after the next write propagates', async () => {
    const { db, deps } = await setUp();
    onPropagate(change => propagateConfig(db, change.kind, deps));
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
    const first = await runOperation<unknown, { warnings?: string[] }>(
      db,
      'test.owedWrite',
      { label: 'first' },
      run
    );
    expect(first.warnings?.[0]).toBe(
      'the change is stored but has not reached Asterisk (core unreachable); api retries it until it does'
    );
    expect(ran).toEqual(['commit first']);

    core.up = true;
    const second = await runOperation<unknown, { warnings?: string[] }>(
      db,
      'test.owedWrite',
      { label: 'second' },
      run
    );
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
