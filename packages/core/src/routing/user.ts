/**
 * Routing pipeline step 4, "Target user" (spec §10.1): the Entry-time decision for a direct call
 * to a user, and the outcome once ringing ends (§11.2 `user_forward_rules`).
 */

import { SIP_BUSY_HERE, SIP_TEMPORARILY_UNAVAILABLE } from '../sipCodes.js';
import type { ForwardTarget } from './targets.js';

export type UserDecision =
  | { kind: 'forward'; target: ForwardTarget }
  | { kind: 'ring'; findMe: { number: string; delayS: number }[] }
  // eslint-disable-next-line no-magic-numbers -- the SIP release codes of the user step's implicit defaults (§10.1)
  | { kind: 'release'; code: 480 | 486 }
  | { kind: 'mailbox'; userId: string };

type OutcomeCondition = 'busy' | 'noAnswer' | 'offline';
type EntryCondition = 'unconditional' | 'dnd' | OutcomeCondition;

/** The implicit default when no rule applies: the user's own mailbox, else `code`. */
function implicitDefault(
  user: { id: string; mailboxEnabled: boolean },
  code: typeof SIP_BUSY_HERE | typeof SIP_TEMPORARILY_UNAVAILABLE
): UserDecision {
  if (user.mailboxEnabled) {
    return { kind: 'mailbox', userId: user.id };
  }
  return { kind: 'release', code };
}

/**
 * The decision for `outcome`: the matching rule, or for `offline` the `noAnswer` rule when
 * `offline` is absent; else the implicit default, 486 for `busy` and 480 otherwise (§10.1).
 */
export function userOutcomeDecision(
  user: { id: string; mailboxEnabled: boolean },
  rules: Partial<Record<OutcomeCondition, ForwardTarget>>,
  outcome: OutcomeCondition
): UserDecision {
  const target =
    rules[outcome] ?? (outcome === 'offline' ? rules.noAnswer : undefined);
  if (target) {
    return { kind: 'forward', target };
  }
  return implicitDefault(
    user,
    outcome === 'busy' ? SIP_BUSY_HERE : SIP_TEMPORARILY_UNAVAILABLE
  );
}

type EntryUser = {
  id: string;
  dnd: boolean;
  mailboxEnabled: boolean;
  findMe: { number: string; delayS: number }[];
  registeredDevices: number;
};

/**
 * Why `userEntryDecision` decides as it does, for the routing trace (§7 "fallback taken"): an
 * `unconditional` forward, DND, `offline` (no registered device and no find-me entry), or `null`
 * when the user's devices ring.
 */
export function userEntryCondition(
  user: EntryUser,
  rules: Partial<Record<EntryCondition, ForwardTarget>>
): 'unconditional' | 'dnd' | 'offline' | null {
  if (rules.unconditional) {
    return 'unconditional';
  }
  if (user.dnd) {
    return 'dnd';
  }
  if (user.registeredDevices === 0 && user.findMe.length === 0) {
    return 'offline';
  }
  return null;
}

/**
 * The Entry-time decision for a direct call to `user`: an unconditional forward wins outright;
 * DND applies its rule or the implicit default; a user with no registered device and no find-me
 * entry is decided as the `offline` outcome; otherwise the devices, and any find-me legs, ring
 * (§10.1 step 4).
 */
export function userEntryDecision(
  user: EntryUser,
  rules: Partial<Record<EntryCondition, ForwardTarget>>
): UserDecision {
  const condition = userEntryCondition(user, rules);
  if (condition === 'unconditional' && rules.unconditional) {
    return { kind: 'forward', target: rules.unconditional };
  }
  if (condition === 'dnd') {
    if (rules.dnd) {
      return { kind: 'forward', target: rules.dnd };
    }
    return implicitDefault(user, SIP_BUSY_HERE);
  }
  if (condition === 'offline') {
    return userOutcomeDecision(user, rules, 'offline');
  }
  return { kind: 'ring', findMe: user.findMe };
}
