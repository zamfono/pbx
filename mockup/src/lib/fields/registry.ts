/**
 * The field registry: every configurable field of every entity, with its tier (Basic, Advanced,
 * Expert), who may change it, and the API operations whose input it belongs to. Forms take labels,
 * help and visibility from here (`FormField`), and `completeness.test.ts` checks the registry
 * against the API's operation inputs (`apiOperations.json`), so no configuration option is missing
 * from Expert mode.
 *
 * Labels: `field.<entity>.<key>`, optional help `field.<entity>.<key>.help` (i18n).
 */
import type { Role } from '#lib/api/types.js';

export type Tier = 'basic' | 'advanced' | 'expert';

export type FieldDef = {
  key: string;
  tier: Tier;
  /** An owner-only field (`OWNER_FIELDS`, ownerOnly conditions): what an admin sees of it. */
  owner?: 'display' | 'hidden';
  /** A `user` may change it on their own record. */
  self?: boolean;
  /** Read-only on the wire (shown, never sent). */
  readOnly?: boolean;
};

export type EntityFields = {
  entity: string;
  /** The operations whose inputs these fields cover. */
  ops: string[];
  fields: FieldDef[];
  /** Input names of those operations that are not form fields (ids, paging, confirm). */
  notFields?: string[];
};

const registry = new Map<string, EntityFields>();

export function defineFields(entity: EntityFields): EntityFields {
  registry.set(entity.entity, entity);
  return entity;
}

export function entityFields(entity: string): EntityFields | undefined {
  return registry.get(entity);
}

export function allEntityFields(): EntityFields[] {
  return [...registry.values()];
}

export function fieldDef(entity: string, key: string): FieldDef | undefined {
  return registry.get(entity)?.fields.find(field => field.key === key);
}

export type FieldAccess = {
  visible: boolean;
  editable: boolean;
  expert: boolean;
};

/** How `role` sees field `key` of `entity` with Expert mode `expert`; `own` when the record is
 * the person's own (self-service). */
export function fieldAccess(
  entity: string,
  key: string,
  role: Role,
  expert: boolean,
  own = false
): FieldAccess {
  const def = fieldDef(entity, key);
  if (def === undefined) {
    return { visible: true, editable: role !== 'user', expert: false };
  }
  const tierVisible = def.tier !== 'expert' || expert;
  if (!tierVisible) {
    return { visible: false, editable: false, expert: true };
  }
  if (def.readOnly === true) {
    return { visible: true, editable: false, expert: def.tier === 'expert' };
  }
  if (role === 'owner') {
    return { visible: true, editable: true, expert: def.tier === 'expert' };
  }
  if (role === 'admin') {
    if (def.owner === 'hidden') {
      return { visible: false, editable: false, expert: false };
    }
    return {
      visible: true,
      editable: def.owner !== 'display',
      expert: def.tier === 'expert'
    };
  }
  return {
    visible: own && def.owner !== 'hidden',
    editable: own && def.self === true,
    expert: def.tier === 'expert'
  };
}
