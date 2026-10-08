/**
 * Where an entity lives in the app, for links from refusals, the audit log, call traces and Mucki.
 */
import type { BlockingRef } from '#lib/api/errors.js';

const PATHS: Record<string, (id: string) => string> = {
  user: id => `/users/${id}`,
  users: id => `/users/${id}`,
  device: () => '/users',
  ringGroup: id => `/ring-groups/${id}`,
  ringGroups: id => `/ring-groups/${id}`,
  userGroup: id => `/user-groups/${id}`,
  userGroups: id => `/user-groups/${id}`,
  menu: id => `/menus/${id}`,
  menus: id => `/menus/${id}`,
  did: () => '/numbers',
  dids: () => '/numbers',
  didBlock: () => '/numbers/blocks',
  didBlocks: () => '/numbers/blocks',
  trunk: id => `/trunks/${id}`,
  trunks: id => `/trunks/${id}`,
  outboundRoute: () => '/outbound-routes',
  audio: () => '/audio',
  contact: () => '/phonebook',
  webhook: () => '/integrations',
  backupTarget: () => '/backups',
  blockedNumber: () => '/blocklist',
  sipAllowlistEntry: () => '/sip-protection',
  oooRule: () => '/company-hours',
  openingHours: () => '/company-hours',
  settings: () => '/settings',
  call: id => `/history/${id}`,
  audit: () => '/audit'
};

export function entityPath(kind: string, id: string): string | null {
  return PATHS[kind]?.(id) ?? null;
}

export function refHref(ref: BlockingRef): string | null {
  const path = entityPath(ref.kind, ref.id);
  return path === null ? null : `#${path}`;
}
