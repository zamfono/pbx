/**
 * The audit log in plain words: what an operation did, which entity it touched, and a diff value
 * as text. Raw operation and field names stay available for Expert mode.
 */
import {
  audioById,
  didById,
  menuById,
  ringGroupById,
  trunkById,
  userById,
  userGroupById
} from '#lib/api/lookup.js';
import type { AuditEntryWire } from '#lib/api/ops/areas/audit.js';
import { store } from '#lib/api/store.svelte.js';
import { FORWARD_TARGET_KINDS, type ForwardTarget } from '#lib/api/types.js';
import { fieldDef } from '#lib/fields/index.js';
import { formatDateTime, formatPhone, has, t } from '#lib/i18n/index.svelte.js';

const VERBS: Record<string, string> = {
  create: 'create',
  update: 'update',
  set: 'update',
  replace: 'update',
  put: 'update',
  setOrder: 'update',
  setForwarding: 'update',
  delete: 'delete',
  erase: 'delete',
  revoke: 'delete',
  lift: 'delete'
};

export function kindLabel(kind: string): string {
  return has(`audit.kind.${kind}`) ? t(`audit.kind.${kind}`) : kind;
}

/** "Ring group changed", "Mail template saved", or the operation's own sentence. */
export function operationText(
  entry: Pick<AuditEntryWire, 'operation' | 'entityKind'>
): string {
  if (has(`audit.op.${entry.operation}`)) {
    return t(`audit.op.${entry.operation}`);
  }
  const verb = VERBS[entry.operation.split('.').at(-1) ?? ''] ?? 'other';
  return t(`audit.verb.${verb}`, {
    kind: kindLabel(entry.entityKind),
    operation: entry.operation
  });
}

/** A readable name for the entity an entry is about. */
export function entityLabel(kind: string, id: string | null): string {
  if (kind === 'settings') {
    return t('nav.settings');
  }
  if (kind === 'system') {
    return t('nav.system');
  }
  if (id === null) {
    return kindLabel(kind);
  }
  const db = store.db;
  switch (kind) {
    case 'user':
      return userById(id)?.name ?? id;
    case 'ringGroup':
      return ringGroupById(id)?.name ?? id;
    case 'userGroup':
      return userGroupById(id)?.name ?? id;
    case 'menu':
      return menuById(id)?.name ?? id;
    case 'did': {
      const did = didById(id);
      return did === undefined
        ? id
        : `${formatPhone(did.number)}${did.label ? ` · ${did.label}` : ''}`;
    }
    case 'trunk':
      return trunkById(id)?.name ?? id;
    case 'audio':
      return audioById(id)?.label ?? id;
    case 'webhook':
      return db.webhooks.find(row => row.id === id)?.url ?? id;
    case 'contact':
      return db.contacts.find(row => row.id === id)?.displayName ?? id;
    case 'blockedNumber':
      return formatPhone(
        db.blockedNumbers.find(row => row.id === id)?.number ?? id
      );
    case 'sipAllowlistEntry':
      return db.sipAllowlist.find(row => row.id === id)?.address ?? id;
    case 'sipBan':
      return db.sipBans.find(row => row.id === id)?.address ?? id;
    case 'device': {
      const device = db.devices.find(row => row.id === id);
      return device === undefined
        ? id
        : `${device.label} · ${userById(device.userId)?.name ?? ''}`;
    }
    case 'backupTarget': {
      const target = db.backupTargets.find(row => row.id === id);
      return target === undefined
        ? id
        : `${t(`backups.kind.${target.kind}`)} · ${String(target.params.host ?? target.params.bucket ?? target.params.url ?? target.params.path ?? '')}`;
    }
    case 'backupRun': {
      const run = db.backupRuns.find(row => row.id === id);
      return run === undefined
        ? kindLabel(kind)
        : entityLabel('backupTarget', run.targetId);
    }
    case 'mailTemplate': {
      const [mailKind = '', language = ''] = id.split(':');
      return `${has(`mailTemplates.kind.${mailKind}`) ? t(`mailTemplates.kind.${mailKind}`) : mailKind} · ${language.toUpperCase()}`;
    }
    default:
      return id;
  }
}

/** The field's label where the registry names one, else its wire name. */
export function fieldLabel(kind: string, field: string): string {
  return has(`field.${kind}.${field}`) ? t(`field.${kind}.${field}`) : field;
}

/** Whether a change to `field` shows: an Expert-tier field's change shows in Expert mode only. */
export function changeVisible(
  kind: string,
  field: string,
  expert: boolean
): boolean {
  return expert || fieldDef(kind, field)?.tier !== 'expert';
}

export function isForwardTarget(value: unknown): value is ForwardTarget {
  return (
    typeof value === 'object' &&
    value !== null &&
    FORWARD_TARGET_KINDS.includes(
      (value as { kind?: string }).kind as ForwardTarget['kind']
    )
  );
}

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/u;
const MAX_TEXT = 140;

/** A diff value as short text. */
export function valueText(value: unknown): string {
  if (value === null || value === undefined) {
    return '—';
  }
  if (typeof value === 'boolean') {
    return value ? t('common.on') : t('common.off');
  }
  if (typeof value === 'string') {
    if (ISO.test(value)) {
      return formatDateTime(value);
    }
    return value.length > MAX_TEXT ? `${value.slice(0, MAX_TEXT)}…` : value;
  }
  if (Array.isArray(value)) {
    if (value.length === 0) {
      return t('audit.emptyList');
    }
    if (value.every(item => typeof item !== 'object' || item === null)) {
      return value.map(item => (item === null ? '∞' : String(item))).join(', ');
    }
  }
  const json = JSON.stringify(value);
  return json.length > MAX_TEXT ? `${json.slice(0, MAX_TEXT)}…` : json;
}
