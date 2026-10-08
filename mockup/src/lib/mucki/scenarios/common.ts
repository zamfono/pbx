/**
 * Helpers the scenario scripts share: quick replies, names and forward targets in words.
 */
import {
  menuById,
  ringGroupById,
  trunkById,
  userById
} from '#lib/api/lookup.js';
import type { ForwardTarget, OooRule } from '#lib/api/types.js';
import { formatPhone, t } from '#lib/i18n/index.svelte.js';

import type { Chip } from '../types';

export const yesNo = (yes: string, no: string): Chip[] => [
  { label: t(yes) },
  { label: t(no) }
];

/** Whether a reply to `yesNo` (or typed text) means yes. */
export function saidYes(
  reply: { text: string; choice: number | null },
  isYes: (text: string) => boolean
): boolean {
  return reply.choice === 0 || (reply.choice === null && isYes(reply.text));
}

export const firstName = (name: string): string =>
  name.replace(/^Dr\.\s*/u, '').split(/\s+/u)[0] ?? name;

/** A forward target in plain words, bold names. */
export function targetText(target: ForwardTarget | null | undefined): string {
  if (target === null || target === undefined) {
    return t('target.none');
  }
  switch (target.kind) {
    case 'user':
      return `**${userById(target.userId)?.name ?? '—'}**`;
    case 'ringGroup':
      return t('mucki.target.ringGroup', {
        name: ringGroupById(target.ringGroupId)?.name ?? '—'
      });
    case 'external':
      return `**${formatPhone(target.external)}**`;
    case 'sip':
      return t('mucki.target.sip', {
        user: target.user,
        trunk: trunkById(target.trunkId)?.name ?? '—'
      });
    case 'mailboxUser':
      return t('mucki.target.mailbox', {
        name: userById(target.userId)?.name ?? '—'
      });
    case 'mailboxRingGroup':
      return t('mucki.target.mailbox', {
        name: ringGroupById(target.ringGroupId)?.name ?? '—'
      });
    case 'announcement':
      return t('target.kind.announcement');
    case 'menu':
      return `**${menuById(target.menuId)?.name ?? '—'}**`;
  }
}

/** Whether an active rule overlaps `[startsAt, expiresAt)`; open ends count as unbounded. */
export function overlaps(
  rule: OooRule,
  startsAt: string,
  expiresAt: string
): boolean {
  if (!rule.active || rule.deletedAt != null) {
    return false;
  }
  const ruleStart =
    rule.startsAt === null ? -Infinity : new Date(rule.startsAt).getTime();
  const ruleEnd =
    rule.expiresAt === null ? Infinity : new Date(rule.expiresAt).getTime();
  return (
    ruleStart < new Date(expiresAt).getTime() &&
    new Date(startsAt).getTime() < ruleEnd
  );
}

/** The number in a SIP URI (`sip:+49…@host`), or the URI. */
export const uriNumber = (uri: string): string =>
  /^sips?:([^@;]+)/u.exec(uri)?.[1] ?? uri;
