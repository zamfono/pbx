import { describe, expect, it } from 'vitest';

import { newId, type Db, type HostStatus } from '@zamfono/shared';
import { seedSettings } from '@zamfono/shared/testDb.js';

import { makeTestDb } from '#testing/testDb.js';

import {
  rebootRequest,
  rebootRequiredSince,
  setRebootRequest
} from '../ops/system/_host.js';
import { UpdaterRefusal, type HostClient } from '../ops/system/_updater.js';
import { runHostPass } from './host.js';
import type { GateCheck, MaintenanceGate } from './maintenanceWindow.js';

const NOW = new Date('2026-11-13T03:00:00Z');
const LATER = new Date('2026-11-14T03:00:00Z');
const KERNEL = {
  since: '2026-11-12T04:10:00.000Z',
  packages: ['linux-image-amd64']
};

/** A host as the updater reads it, and what was asked of it. */
function fakeHost(
  initial: HostStatus,
  reboot: () => Promise<void> = () => Promise.resolve()
): HostClient & { asked: string[] } {
  let status = initial;
  const asked: string[] = [];
  return {
    asked,
    read: () => Promise.resolve(status),
    check: () => Promise.resolve(status),
    setUpdates: enabled => {
      asked.push(`updates ${String(enabled)}`);
      status = { ...status, updates: enabled };
      return Promise.resolve();
    },
    reboot: async () => {
      asked.push('reboot');
      await reboot();
    }
  };
}

function fakeGate(verdict: GateCheck = { open: true }): MaintenanceGate & {
  checks: number;
} {
  const gate = {
    checks: 0,
    check: () => {
      gate.checks += 1;
      return Promise.resolve(verdict);
    },
    reset: () => Promise.resolve()
  };
  return gate;
}

async function hostDb(
  settings: { hostUpdates?: number | null; autoReboot?: number } = {}
): Promise<Db> {
  const db = await makeTestDb();
  await seedSettings(db, settings);
  return db;
}

async function auditOutcomes(db: Db): Promise<string[]> {
  const rows = await db
    .selectFrom('auditLog')
    .select(['operation', 'changesJson'])
    .where('operation', '=', 'system.hostReboot')
    .execute();
  return rows.map(row => row.changesJson);
}

describe('runHostPass (§6.3 "Host control")', () => {
  it('does nothing without host control', async () => {
    const db = await hostDb();
    const gate = fakeGate();
    await expect(
      runHostPass({ db, gate, host: () => undefined, now: () => NOW })
    ).resolves.toBeNull();
    expect(gate.checks).toBe(0);
  });

  it("takes the host's upgrades as the setting until one is set, then keeps the host to it", async () => {
    const db = await hostDb();
    const host = fakeHost({ rebootRequired: null, updates: true });
    const deps = { db, gate: fakeGate(), host: () => host, now: () => NOW };
    await runHostPass(deps);
    const adopted = await db
      .selectFrom('settings')
      .select('hostUpdates')
      .executeTakeFirstOrThrow();
    expect(adopted.hostUpdates).toBe(1);
    expect(host.asked).toEqual([]);

    await db.updateTable('settings').set({ hostUpdates: 0 }).execute();
    await runHostPass(deps);
    expect(host.asked).toEqual(['updates false']);
  });

  it('reboots a host that waits for it at an open gate, with autoReboot on', async () => {
    const db = await hostDb({ autoReboot: 1 });
    const host = fakeHost({ rebootRequired: KERNEL, updates: true });
    await runHostPass({
      db,
      gate: fakeGate(),
      host: () => host,
      now: () => NOW
    });
    expect(host.asked).toEqual(['reboot']);
    await expect(rebootRequiredSince(db)).resolves.toBe(KERNEL.since);
    const [changes] = await auditOutcomes(db);
    expect(JSON.parse(changes ?? '[]')).toContainEqual({
      field: 'trigger',
      from: null,
      to: 'automatic'
    });
  });

  it('waits for the gate, and leaves a waiting host alone with autoReboot off', async () => {
    const db = await hostDb({ autoReboot: 1 });
    const host = fakeHost({ rebootRequired: KERNEL, updates: true });
    const shut = fakeGate({ open: false, nextCheckAt: LATER });
    await expect(
      runHostPass({ db, gate: shut, host: () => host, now: () => NOW })
    ).resolves.toEqual(LATER);
    expect(host.asked).toEqual([]);

    const off = await hostDb({ autoReboot: 0 });
    const gate = fakeGate();
    await runHostPass({ db: off, gate, host: () => host, now: () => NOW });
    expect(gate.checks).toBe(0);
    expect(host.asked).toEqual([]);
  });

  it("carries out an owner's scheduled reboot, and keeps it while the updater refuses", async () => {
    const db = await hostDb({ autoReboot: 0 });
    await setRebootRequest(db, { at: NOW.toISOString(), by: 'Olga Owner' });
    const refusing = fakeHost({ rebootRequired: null, updates: true }, () =>
      Promise.reject(new UpdaterRefusal(409, 'an update is running'))
    );
    const soon = await runHostPass({
      db,
      gate: fakeGate(),
      host: () => refusing,
      now: () => NOW
    });
    expect(soon?.getTime()).toBeGreaterThan(NOW.getTime());
    await expect(rebootRequest(db)).resolves.toMatchObject({
      by: 'Olga Owner'
    });
    await expect(auditOutcomes(db)).resolves.toEqual([]);

    const host = fakeHost({ rebootRequired: null, updates: true });
    await runHostPass({
      db,
      gate: fakeGate(),
      host: () => host,
      now: () => NOW
    });
    expect(host.asked).toEqual(['reboot']);
    await expect(rebootRequest(db)).resolves.toBeNull();
    expect(await auditOutcomes(db)).toHaveLength(1);
  });

  it('waits while a backup runs, and never reboots where the stack would not come back', async () => {
    const db = await hostDb({ autoReboot: 1 });
    const targetId = newId();
    await db
      .insertInto('backupTargets')
      .values({
        id: targetId,
        kind: 'local',
        paramsJson: '{"path":"/backups/restic"}',
        enabled: 1,
        secretEnc: Buffer.from('x'),
        createdAt: NOW.toISOString()
      })
      .execute();
    await db
      .insertInto('backupRuns')
      .values({
        id: newId(),
        targetId,
        status: 'running',
        startedAt: NOW.toISOString()
      })
      .execute();
    const host = fakeHost({ rebootRequired: KERNEL, updates: true });
    await runHostPass({
      db,
      gate: fakeGate(),
      host: () => host,
      now: () => NOW
    });
    expect(host.asked).toEqual([]);

    const podman = fakeHost({
      rebootRequired: KERNEL,
      updates: true,
      rebootRefused: 'no boot unit'
    });
    const gate = fakeGate();
    await runHostPass({
      db: await hostDb({ autoReboot: 1 }),
      gate,
      host: () => podman,
      now: () => NOW
    });
    expect(gate.checks).toBe(0);
    expect(podman.asked).toEqual([]);
  });
});
