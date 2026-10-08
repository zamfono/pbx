/**
 * The realtime event stream (§10.6): what `/events` and webhooks carry. Operations and the
 * simulator emit; the bell, live screens and Mucki subscribe. Delivery per person follows
 * `lib/server/events.ts`: admins and owners receive every event; a `user` only their own presence
 * and calls, tenant-wide out-of-office and opening-hours events, and voicemail of their own or
 * their ring groups' mailboxes.
 */
import { nowDate as demoNowDate } from '#lib/clock.svelte.js';

import { newId } from './ids';
import { store } from './store.svelte';
import type { Db, Envelope, Role, ZEvent } from './types';

const KEEP_EVENTS = 200;

type Listener = (event: Envelope) => void;
const listeners = new Set<Listener>();

export function emit(event: ZEvent, audience?: string[]): Envelope {
  const envelope = {
    ...event,
    id: newId(),
    at: demoNowDate().toISOString(),
    ...(audience === undefined ? {} : { audience })
  } as Envelope;
  store.db.events.unshift(envelope);
  store.db.events.length = Math.min(store.db.events.length, KEEP_EVENTS);
  for (const listener of listeners) {
    listener(envelope);
  }
  return envelope;
}

export function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The ring groups `userId` belongs to, directly or through nested user groups. */
export function ringGroupsOf(db: Db, userId: string): string[] {
  const groupsWithUser = new Set<string>();
  let grew = true;
  while (grew) {
    grew = false;
    for (const group of db.userGroups) {
      if (group.deletedAt !== null || groupsWithUser.has(group.id)) {
        continue;
      }
      const contains = group.members.some(
        member =>
          (member.kind === 'user' && member.id === userId) ||
          (member.kind === 'userGroup' && groupsWithUser.has(member.id))
      );
      if (contains) {
        groupsWithUser.add(group.id);
        grew = true;
      }
    }
  }
  return db.ringGroups
    .filter(
      group =>
        group.deletedAt === null &&
        group.members.some(
          member =>
            (member.kind === 'user' && member.id === userId) ||
            (member.kind === 'userGroup' && groupsWithUser.has(member.id))
        )
    )
    .map(group => group.id);
}

/** Whether `event` reaches a person with `role` and id `userId` (§10.6). */
export function visibleTo(
  db: Db,
  event: Envelope,
  role: Role,
  userId: string
): boolean {
  if (role !== 'user') {
    return true;
  }
  switch (event.type) {
    case 'presence':
      return event.userId === userId;
    case 'call.state':
    case 'history.appended':
      return event.audience?.includes(userId) ?? false;
    case 'ooo':
    case 'hours':
      return event.scope === 'tenant' || event.scope === `user:${userId}`;
    case 'voicemail.new':
      return event.mailbox.kind === 'user'
        ? event.mailbox.userId === userId
        : ringGroupsOf(db, userId).includes(event.mailbox.ringGroupId);
    default:
      return false;
  }
}
