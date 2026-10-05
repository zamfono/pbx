/**
 * `core`'s count of failed SIP attempts per source address (§5.6 "Counting"), fed by the AMI
 * security events: a sliding window of failure times per address and the time of each address's
 * last successful authentication, both in memory since `core` started.
 */
import { isIP } from 'node:net';

import { addressKey, MS_PER_SECOND, type SipBanReport } from '@zamfono/shared';

import type { AmiEvent } from '../ami/frame.js';
import type { ParsedSettings } from '../internal/snapshotRows.js';

/** The security events that count as a failed attempt; `ChallengeSent` and `SuccessfulAuth` never do. */
const COUNTED_EVENTS = new Set([
  'InvalidAccountID',
  'ChallengeResponseFailed',
  'InvalidPassword',
  'FailedACL'
]);
const SUCCESS_EVENT = 'SuccessfulAuth';
// A `RemoteAddress`'s address is its last part but one, before the port.
const ADDRESS_FROM_END = -2;

export type SipBanThresholds = Pick<
  ParsedSettings,
  'sipBanFailures' | 'sipBanWindowS' | 'sipBanSuccessExemptS'
>;

/**
 * The count key of a security event's `RemoteAddress`, which Asterisk writes as
 * `IPV4/UDP/203.0.113.7/5060`, the transport left out where it has none (`ast_json_ipaddr`): the
 * address, an IPv6 one as its /64; `null` for a value that holds no address.
 */
export function sourceKey(remoteAddress: string): string | null {
  const address = remoteAddress.split('/').at(ADDRESS_FROM_END);
  return address !== undefined && isIP(address) !== 0
    ? addressKey(address)
    : null;
}

export class SipBanCount {
  private readonly now: () => number;
  /** Per address, the times of its failures within the window, oldest first. */
  private readonly failures = new Map<string, number[]>();
  /** Per address, the time of its last successful authentication. */
  private readonly successes = new Map<string, number>();

  constructor(now: () => number) {
    this.now = now;
  }

  /** The addresses held, by their failures or their success; what `sweep` bounds. */
  get size(): number {
    return this.failures.size + this.successes.size;
  }

  /**
   * Counts `event`; the report for its address when this failure reached `sipBanFailures` and the
   * address authenticated successfully within none of the last `sipBanSuccessExemptS`, else
   * `null`. A crossing clears the address's count, so it reports once per crossing.
   */
  record(event: AmiEvent, thresholds: SipBanThresholds): SipBanReport | null {
    const isFailure = COUNTED_EVENTS.has(event.Event ?? '');
    if (!isFailure && event.Event !== SUCCESS_EVENT) {
      return null;
    }
    const address = sourceKey(event.RemoteAddress ?? '');
    if (address === null) {
      return null;
    }
    const now = this.now();
    if (!isFailure) {
      this.successes.set(address, now);
      return null;
    }
    const since = now - thresholds.sipBanWindowS * MS_PER_SECOND;
    const times = (this.failures.get(address) ?? []).filter(at => at > since);
    times.push(now);
    if (times.length < thresholds.sipBanFailures) {
      this.failures.set(address, times);
      return null;
    }
    this.failures.delete(address);
    return this.succeededRecently(address, now, thresholds)
      ? null
      : { address, failures: times.length };
  }

  /**
   * Drops every address whose last failure left the window and every success past the exemption,
   * so the memory held is that of the addresses active within them.
   */
  sweep(thresholds: SipBanThresholds): void {
    const now = this.now();
    const since = now - thresholds.sipBanWindowS * MS_PER_SECOND;
    for (const [address, times] of this.failures) {
      if ((times.at(-1) ?? 0) <= since) {
        this.failures.delete(address);
      }
    }
    for (const address of this.successes.keys()) {
      if (!this.succeededRecently(address, now, thresholds)) {
        this.successes.delete(address);
      }
    }
  }

  private succeededRecently(
    address: string,
    now: number,
    thresholds: SipBanThresholds
  ): boolean {
    const at = this.successes.get(address);
    return (
      at !== undefined &&
      thresholds.sipBanSuccessExemptS > 0 &&
      now - at <= thresholds.sipBanSuccessExemptS * MS_PER_SECOND
    );
  }
}
