/**
 * Reads of the mock tenant by id, for labels and pickers. They read the reactive store, so they
 * update wherever a template uses them.
 */
import { store } from './store.svelte';
import type {
  AudioAsset,
  AudioKind,
  Did,
  ForwardTarget,
  Menu,
  RingGroup,
  Trunk,
  User,
  UserGroup
} from './types';

const live = <T extends { deletedAt: string | null }>(rows: T[]): T[] =>
  rows.filter(row => row.deletedAt === null);

export const liveUsers = (): User[] => live(store.db.users);
export const liveRingGroups = (): RingGroup[] => live(store.db.ringGroups);
export const liveUserGroups = (): UserGroup[] => live(store.db.userGroups);
export const liveMenus = (): Menu[] => live(store.db.menus);
export const liveTrunks = (): Trunk[] => live(store.db.trunks);
export const liveDids = (): Did[] => live(store.db.dids);
export const liveAudio = (kind?: AudioKind): AudioAsset[] =>
  live(store.db.audio).filter(
    asset => kind === undefined || asset.kind === kind
  );

export const userById = (id: string | null | undefined): User | undefined =>
  store.db.users.find(user => user.id === id);
export const ringGroupById = (
  id: string | null | undefined
): RingGroup | undefined => store.db.ringGroups.find(group => group.id === id);
export const userGroupById = (
  id: string | null | undefined
): UserGroup | undefined => store.db.userGroups.find(group => group.id === id);
export const menuById = (id: string | null | undefined): Menu | undefined =>
  store.db.menus.find(menu => menu.id === id);
export const trunkById = (id: string | null | undefined): Trunk | undefined =>
  store.db.trunks.find(trunk => trunk.id === id);
export const audioById = (
  id: string | null | undefined
): AudioAsset | undefined => store.db.audio.find(asset => asset.id === id);
export const didById = (id: string | null | undefined): Did | undefined =>
  store.db.dids.find(did => did.id === id);

export const userName = (id: string | null | undefined): string =>
  userById(id)?.name ?? '—';

/** The user or ring group an extension belongs to, or a parking slot. */
export function extensionOwner(
  ext: string
):
  | { kind: 'user'; user: User }
  | { kind: 'ringGroup'; group: RingGroup }
  | { kind: 'parking' }
  | null {
  const user = liveUsers().find(candidate => candidate.extension === ext);
  if (user) {
    return { kind: 'user', user };
  }
  const group = liveRingGroups().find(candidate => candidate.ext === ext);
  if (group) {
    return { kind: 'ringGroup', group };
  }
  return store.db.parkingSlots.includes(ext) ? { kind: 'parking' } : null;
}

/** A user's own presence status (`dnd` overrides the device-derived state). */
export function presenceOf(
  userId: string
): 'available' | 'busy' | 'offline' | 'dnd' {
  const user = userById(userId);
  if (user?.dnd === true) {
    return 'dnd';
  }
  return store.db.presence[userId]?.status ?? 'offline';
}

/** The ids every target of `target` references, for "used by" checks. */
export function targetRefs(
  target: ForwardTarget | null | undefined
): { kind: string; id: string }[] {
  if (target === null || target === undefined) {
    return [];
  }
  switch (target.kind) {
    case 'user':
    case 'mailboxUser':
      return [{ kind: 'user', id: target.userId }];
    case 'ringGroup':
    case 'mailboxRingGroup':
      return [{ kind: 'ringGroup', id: target.ringGroupId }];
    case 'sip':
      return [{ kind: 'trunk', id: target.trunkId }];
    case 'announcement':
      return [{ kind: 'audio', id: target.audioId }];
    case 'menu':
      return [{ kind: 'menu', id: target.menuId }];
    default:
      return [];
  }
}

/** Every forward target in the tenant with a label of where it is set, for blocking-reference checks. */
export function allTargets(): {
  owner: { kind: string; id: string; label: string };
  target: ForwardTarget;
}[] {
  const db = store.db;
  const out: {
    owner: { kind: string; id: string; label: string };
    target: ForwardTarget;
  }[] = [];
  for (const did of live(db.dids)) {
    out.push({
      owner: { kind: 'did', id: did.id, label: did.label ?? did.number },
      target: did.target
    });
  }
  for (const block of live(db.didBlocks)) {
    if (block.fallbackTarget) {
      out.push({
        owner: {
          kind: 'didBlock',
          id: block.id,
          label: block.label ?? block.base
        },
        target: block.fallbackTarget
      });
    }
  }
  for (const menu of live(db.menus)) {
    out.push({
      owner: { kind: 'menu', id: menu.id, label: menu.name },
      target: menu.fallbackTarget
    });
    for (const entry of menu.targets) {
      out.push({
        owner: {
          kind: 'menu',
          id: menu.id,
          label: `${menu.name} · ${entry.digits}`
        },
        target: entry.target
      });
    }
  }
  for (const [userId, rules] of Object.entries(db.userForwarding)) {
    for (const rule of rules) {
      out.push({
        owner: { kind: 'user', id: userId, label: userName(userId) },
        target: rule.target
      });
    }
  }
  for (const [groupId, rules] of Object.entries(db.ringGroupForwarding)) {
    for (const rule of rules) {
      out.push({
        owner: {
          kind: 'ringGroup',
          id: groupId,
          label: ringGroupById(groupId)?.name ?? groupId
        },
        target: rule.target
      });
    }
  }
  for (const rule of live(db.oooRules)) {
    out.push({
      owner: { kind: 'oooRule', id: rule.id, label: 'OOO' },
      target: rule.target
    });
  }
  for (const hours of live(db.openingHours)) {
    out.push({
      owner: { kind: 'openingHours', id: hours.id, label: 'Hours' },
      target: hours.closedTarget
    });
  }
  if (db.settings.fallbackTarget) {
    out.push({
      owner: { kind: 'settings', id: 'settings', label: 'Settings' },
      target: db.settings.fallbackTarget
    });
  }
  return out;
}
