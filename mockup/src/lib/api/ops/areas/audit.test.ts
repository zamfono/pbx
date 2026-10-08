import { beforeEach, describe, expect, it } from 'vitest';

import '#lib/api/ops/index.js';

import { ApiError } from '#lib/api/errors.js';
import { call, type Actor } from '#lib/api/ops/core.js';
import { OOO, RG, U, WEBHOOK } from '#lib/api/seed/ids.js';
import { resetDb, store } from '#lib/api/store.svelte.js';

import type { AuditEntryWire } from './audit';
import type { WebhookWire } from './webhooks';

const lea: Actor = { id: U.lea, name: 'Lea Brandt', role: 'owner' };
const jonas: Actor = { id: U.jonas, name: 'Jonas Weber', role: 'admin' };
const mira: Actor = { id: U.mira, name: 'Mira Kovač', role: 'user' };

const run = <O>(
  actor: Actor,
  name: string,
  input: unknown,
  confirmed = false
): O => call<O>(name, input, { actor, channel: 'ui', confirmed });

function refusal(fn: () => unknown): ApiError {
  try {
    fn();
  } catch (error) {
    if (error instanceof ApiError) {
      return error;
    }
    throw error;
  }
  throw new Error('expected a refusal');
}

const list = (actor: Actor, input: object = {}): AuditEntryWire[] =>
  run<{ items: AuditEntryWire[] }>(actor, 'audit.list', input).items;

beforeEach(() => {
  resetDb();
});

describe('audit.list', () => {
  it('is admin-only, newest first, and filters', () => {
    expect(refusal(() => list(mira)).code).toBe('forbiddenRole');
    const all = list(jonas);
    expect(all.length).toBeGreaterThan(3);
    expect(all.map(entry => entry.createdAt)).toEqual(
      [...all.map(entry => entry.createdAt)].sort().reverse()
    );
    expect(
      list(jonas, { channel: 'mcp' }).every(
        entry => entry.clientName === 'Claude Code'
      )
    ).toBe(true);
    expect(
      list(jonas, { entityKind: 'ringGroup', entityId: RG.support })
    ).toHaveLength(2);
    expect(
      list(jonas, { actorUserId: U.lea }).every(
        entry => entry.actorUserName === 'Lea Brandt'
      )
    ).toBe(true);
    expect('revert' in (all[0] ?? {})).toBe(false);
  });
});

describe('audit.undo', () => {
  it('undoes a seeded change by its diff and refuses an earlier one while a later change stands', () => {
    const [newer, older] = list(jonas, {
      entityKind: 'ringGroup',
      entityId: RG.support
    });
    expect(
      refusal(() => run(jonas, 'audit.undo', { id: older?.id })).code
    ).toBe('undoLaterChange');
    run(jonas, 'audit.undo', { id: newer?.id });
    expect(
      store.db.ringGroups.find(group => group.id === RG.support)?.logLevel
    ).toBeNull();
    expect(list(jonas, { state: 'undone' }).map(entry => entry.id)).toContain(
      newer?.id
    );
    expect(list(jonas)[0]).toMatchObject({
      operation: 'audit.undo',
      channel: 'undo',
      revertsId: newer?.id,
      undoable: false
    });
    run(jonas, 'audit.undo', { id: older?.id });
    expect(
      store.db.ringGroups.find(group => group.id === RG.support)?.ringTotalS
    ).toBe(60);
  });

  it('undoes a creation by deleting what it created', () => {
    const entry = list(jonas, { entityKind: 'oooRule' })[0];
    run(jonas, 'audit.undo', { id: entry?.id });
    expect(
      store.db.oooRules.find(rule => rule.id === OOO.felixVacation)?.deletedAt
    ).not.toBeNull();
    expect(
      refusal(() => run(jonas, 'audit.undo', { id: entry?.id })).code
    ).toBe('undoAlreadyUndone');
  });

  it('refuses entries that cannot be undone', () => {
    const webhook = list(jonas, {
      entityKind: 'webhook',
      entityId: WEBHOOK.crm
    })[0];
    expect(
      refusal(() => run(jonas, 'audit.undo', { id: webhook?.id })).code
    ).toBe('undoNotUndoable');
  });

  it('an undo of a webhook change restores it; a secret change cannot be undone', () => {
    run<WebhookWire>(jonas, 'webhooks.update', {
      id: WEBHOOK.crm,
      active: false
    });
    run(jonas, 'audit.undo', { id: store.db.audit[0]?.id });
    expect(store.db.webhooks[0]?.active).toBe(true);
    run<WebhookWire>(jonas, 'webhooks.update', {
      id: WEBHOOK.crm,
      secret: 'new'
    });
    expect(store.db.audit[0]).toMatchObject({
      undoable: false,
      changes: [{ field: 'secret', from: '•••', to: '•••' }]
    });
  });

  it('restoring a deleted admin is owner-only', () => {
    store.db.audit.unshift({
      id: 'deleted-admin',
      actorUserId: U.lea,
      actorUserName: 'Lea Brandt',
      channel: 'ui',
      clientId: null,
      clientName: null,
      operation: 'users.delete',
      entityKind: 'user',
      entityId: U.jonas,
      changes: [
        { field: 'deletedAt', from: null, to: new Date().toISOString() }
      ],
      undoable: true,
      revertsId: null,
      undoneAt: null,
      createdAt: new Date().toISOString(),
      revert: []
    });
    expect(
      refusal(() => run(jonas, 'audit.undo', { id: 'deleted-admin' })).code
    ).toBe('forbiddenOwnerOnly');
    run(lea, 'audit.undo', { id: 'deleted-admin' });
  });
});
