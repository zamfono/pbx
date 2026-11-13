/**
 * `core`'s count of failed SIP attempts per source address and protocol (§5.6 "Counting"), fed by
 * the AMI security events: a sliding window of failure times per address and protocol and the
 * time of each one's last successful authentication, both in memory since `core` started.
 */
import { isIP } from 'node:net';

import {
  addressKey,
  MS_PER_SECOND,
  type SipBanProtocol,
  type SipBanReport
} from '@zamfono/shared';

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
/** A `RemoteAddress`'s transport, as Asterisk names it, by the protocol a ban drops. */
const PROTOCOLS: Readonly<Record<string, SipBanProtocol>> = {
  UDP: 'udp',
  TCP: 'tcp',
  TLS: 'tcp'
};

export type SipBanThresholds = Pick<
  ParsedSettings,
  'sipBanFailures' | 'sipBanWindowS' | 'sipBanSuccessExemptS'
>;

/**
 * The source counted for a security event's `RemoteAddress`, its address, an IPv6 one as its /64,
 * and the protocol it came over; Asterisk writes the value as `IPV4/UDP/203.0.113.7/5060`
 * (`ast_json_ipaddr`). `null` for a value that holds no address or names no transport or one
 * other than UDP, TCP and TLS, which no drop rule covers (§5.6 "Enforcement").
 */
export function sourceOf(
  remoteAddress: string
): Pick<SipBanReport, 'address' | 'protocol'> | null {
  const [, transport = '', address = ''] = remoteAddress.split('/');
  const protocol = PROTOCOLS[transport];
  return protocol !== undefined && isIP(address) !== 0
    ? { address: addressKey(address), protocol }
    : null;
}

export class SipBanCount {
  private readonly now: () => number;
  /** Per address and protocol, the times of its failures within the window, oldest first. */
  private readonly failures = new Map<string, number[]>();
  /** Per address and protocol, the time of its last successful authentication. */
  private readonly successes = new Map<string, number>();

  constructor(now: () => number) {
    this.now = now;
  }

  /** The sources held, by their failures or their success; what `sweep` bounds. */
  get size(): number {
    return this.failures.size + this.successes.size;
  }

  /**
   * Counts `event`; the report for its source, the address and protocol, when this failure reached
   * `sipBanFailures` and the source authenticated successfully within none of the last
   * `sipBanSuccessExemptS`, else `null`. A crossing clears the source's count, so it reports once
   * per crossing. `ownEndpoints` names the endpoints the stack renders: an `InvalidAccountID` for
   * one of them is a device's or trunk's first request, without credentials, or one sent before
   * Asterisk had loaded its endpoint, and never counts.
   */
  record(
    event: AmiEvent,
    thresholds: SipBanThresholds,
    ownEndpoints: ReadonlySet<string> = new Set()
  ): SipBanReport | null {
    if (
      event.Event === 'InvalidAccountID' &&
      ownEndpoints.has(event.AccountID ?? '')
    ) {
      return null;
    }
    const isFailure = COUNTED_EVENTS.has(event.Event ?? '');
    if (!isFailure && event.Event !== SUCCESS_EVENT) {
      return null;
    }
    const source = sourceOf(event.RemoteAddress ?? '');
    if (source === null) {
      return null;
    }
    const key = `${source.protocol} ${source.address}`;
    const now = this.now();
    if (!isFailure) {
      this.successes.set(key, now);
      return null;
    }
    const since = now - thresholds.sipBanWindowS * MS_PER_SECOND;
    const times = (this.failures.get(key) ?? []).filter(at => at > since);
    times.push(now);
    if (times.length < thresholds.sipBanFailures) {
      this.failures.set(key, times);
      return null;
    }
    this.failures.delete(key);
    return this.succeededRecently(key, now, thresholds)
      ? null
      : { ...source, failures: times.length };
  }

  /**
   * Drops every source whose last failure left the window and every success past the exemption,
   * so the memory held is that of the sources active within them.
   */
  sweep(thresholds: SipBanThresholds): void {
    const now = this.now();
    const since = now - thresholds.sipBanWindowS * MS_PER_SECOND;
    for (const [key, times] of this.failures) {
      if ((times.at(-1) ?? 0) <= since) {
        this.failures.delete(key);
      }
    }
    for (const key of this.successes.keys()) {
      if (!this.succeededRecently(key, now, thresholds)) {
        this.successes.delete(key);
      }
    }
  }

  private succeededRecently(
    key: string,
    now: number,
    thresholds: SipBanThresholds
  ): boolean {
    const at = this.successes.get(key);
    return (
      at !== undefined &&
      thresholds.sipBanSuccessExemptS > 0 &&
      now - at <= thresholds.sipBanSuccessExemptS * MS_PER_SECOND
    );
  }
}
