/**
 * Trunk registration/reachability state (spec §9.4 "Provisioning and status"), resynced at boot
 * and followed by events: `ip` trunks from the ARI endpoint list and `ContactStatusChange` on the
 * first host's contact, `registration` trunks from the AMI `PJSIPShowRegistrationsOutbound`
 * action (at boot and on AMI reconnect) and `Registry` events; `trunkStatus.ts` reads each of
 * them as a status, and every `Registered` one as the trunk's `registeredAt`. Also the per-trunk active-channel count `outbound.ts`'s channel cap (§9.4
 * "Channels") reads, since nothing else in the process tracks it; it lives in the `StateStore`,
 * whose `trunkChannels` `api` exports in `/metrics` (§7).
 */
import { HTTP_CONFLICT, trunkSectionName } from '@zamfono/shared';

import type { AmiClient } from '../ami/client.js';
import type { AmiEvent } from '../ami/frame.js';
import type { AriClient } from '../ari/client.js';
import { isEvent, type AriEvent, type AriEventOf } from '../ari/events.js';
import { logFailure } from '../ari/failures.js';
import type { Logger } from '../ari/types.js';
import type { EventBus } from '../internal/eventBus.js';
import type { ConfigCache, Snapshot } from '../internal/snapshot.js';
import type { StateStore } from '../internal/stateStore.js';
import { ActionError } from './actionError.js';
import { waitForEvent } from './ariWaits.js';
import {
  contactEventStatus,
  endpointStatuses,
  monitoringStatuses,
  onEnabledTransports,
  registrationDetailStatuses,
  registrationTrunks,
  registryEventStatus,
  type PlainTransports,
  type StatusChange,
  type TrunkStatus
} from './trunkStatus.js';

type TrunkStateDeps = {
  ari: AriClient;
  ami: AmiClient;
  cache: ConfigCache;
  state: StateStore;
  bus: EventBus;
  log: Logger;
  now: () => string;
  plainTransports: PlainTransports;
};

export class TrunkState {
  private readonly deps: TrunkStateDeps;
  // The trunk each counted leg's channel occupies, by channel: a leg ends once, however many of
  // its watchers see it end (an attempt hung up while its dial is in flight is seen by both).
  private readonly countedLegs = new Map<string, string>();

  constructor(deps: TrunkStateDeps) {
    this.deps = deps;
    this.deps.ari.on('event', (event: AriEvent) => {
      if (isEvent(event, 'ContactStatusChange')) {
        this.handleContactStatusChange(event).catch(
          logFailure(this.deps.log, 'trunk contact status change')
        );
      }
    });
    this.deps.ami.on('event', (event: AmiEvent) => {
      if (event.Event === 'Registry') {
        this.handleRegistry(event).catch(
          logFailure(this.deps.log, 'trunk registration update')
        );
      }
    });
    this.deps.ami.on('connected', () => {
      this.forgetRegistrationTimes();
      this.resyncRegistrations().catch(
        logFailure(this.deps.log, 'trunk registration resync')
      );
    });
  }

  /** The trunk's currently active legs, inbound and outbound, for `channelCapAllows` (§9.4
   * "Channels"). */
  activeChannels(trunkId: string): number {
    return this.deps.state.trunkChannels.get(trunkId) ?? 0;
  }

  /** Counts the leg on `channelId` among `trunkId`'s active legs. */
  noteAttemptStarted(trunkId: string, channelId: string): void {
    if (this.countedLegs.has(channelId)) {
      return;
    }
    this.countedLegs.set(channelId, trunkId);
    this.deps.state.trunkChannels.set(
      trunkId,
      this.activeChannels(trunkId) + 1
    );
  }

  /** Counts the leg on `channelId` off its trunk; a leg not counted (any more) is left alone. */
  noteAttemptEnded(channelId: string): void {
    const trunkId = this.countedLegs.get(channelId);
    if (trunkId === undefined) {
      return;
    }
    this.countedLegs.delete(channelId);
    const next = this.activeChannels(trunkId) - 1;
    // Kept in the live state, which `/metrics` reports (§7), so a trunk carrying none drops out.
    if (next > 0) {
      this.deps.state.trunkChannels.set(trunkId, next);
    } else {
      this.deps.state.trunkChannels.delete(trunkId);
    }
  }

  /** The channels of the legs counted right now. */
  get countedChannels(): string[] {
    return [...this.countedLegs.keys()];
  }

  /**
   * Watches `channelId`, a call that arrived from a trunk, for its `ChannelDestroyed` from the
   * moment it enters, before the config read that names its trunk: a caller hanging up during that
   * read is seen, not left counted forever. The returned function counts the leg among that
   * trunk's active legs until the channel is destroyed (§9.4 "Channels"): the provider enforces
   * its own limit inbound, so nothing is refused here, but the leg occupies one of the channels
   * the trunk's cap and `/metrics` count. `null` (no trunk identified) stops watching.
   */
  watchInboundLeg(channelId: string): (trunkId: string | null) => void {
    let destroyed = false;
    const watch = waitForEvent<undefined>(this.deps.ari, (event, waiting) => {
      const channel = event.channel;
      if (event.type !== 'ChannelDestroyed' || channel?.id !== channelId) {
        return;
      }
      waiting.settle(undefined);
      destroyed = true;
      this.noteAttemptEnded(channelId);
    });
    return trunkId => {
      if (trunkId === null) {
        watch.settle(undefined);
        return;
      }
      // A leg already gone never occupies a channel.
      if (!destroyed) {
        this.noteAttemptStarted(trunkId, channelId);
      }
    };
  }

  /** Reads every trunk's status at boot (§9.4 "resyncs at boot"): registrations and contacts. */
  async resyncOnBoot(): Promise<void> {
    await this.resyncRegistrations();
    await this.resyncContacts();
  }

  /** Reads every `registration` trunk's outcome from AMI, at boot and on AMI reconnect. */
  async resyncRegistrations(): Promise<void> {
    const snapshot = await this.deps.cache.get();
    if (registrationTrunks(snapshot).length === 0) {
      return;
    }
    const frames = await this.deps.ami.action('PJSIPShowRegistrationsOutbound');
    this.apply(snapshot, registrationDetailStatuses(snapshot, frames));
  }

  /**
   * Reads every `ip` trunk's reachability from the ARI endpoint list at boot: a `qualify` result
   * that came in while this process was down raises no `ContactStatusChange` for it to follow.
   */
  async resyncContacts(): Promise<void> {
    const snapshot = await this.deps.cache.get();
    this.apply(
      snapshot,
      endpointStatuses(snapshot, await this.deps.ari.endpoints.list())
    );
  }

  /**
   * Settles the `unmonitored` statuses after a config change (`/internal/configChanged`, §3.1):
   * a trunk whose `qualify` was just switched off gets no reliable `ContactStatusChange` saying
   * so, and one switched back on is `unknown` until its first probe answers (§9.4 "Provisioning
   * and status").
   */
  async refreshMonitoring(): Promise<void> {
    const snapshot = await this.deps.cache.get();
    this.apply(
      snapshot,
      monitoringStatuses(
        snapshot,
        trunkId => this.deps.state.trunks.get(trunkId)?.status
      )
    );
  }

  /**
   * Has Asterisk register `trunkId` afresh (`trunks.reregister`, §9.4 "Provisioning and
   * status"): `PJSIPRegister` unregisters the trunk's registration, then registers it and
   * reschedules its refreshes; resolves once Asterisk queued both, the outcome following as
   * `Registry` events. A trunk the config holds no registration for is refused, so only a
   * registration's own section name reaches the AMI frame.
   */
  async reregister(trunkId: string): Promise<void> {
    const snapshot = await this.deps.cache.get();
    if (!registrationTrunks(snapshot).some(trunk => trunk.id === trunkId)) {
      throw new ActionError(
        HTTP_CONFLICT,
        'noRegistration',
        'trunk has no registration'
      );
    }
    await this.deps.ami.send('PJSIPRegister', {
      Registration: trunkSectionName(trunkId)
    });
  }

  /** On a new AMI connection: a REGISTER that succeeded while none was open raised a `Registry`
   * event nobody read, so no `registeredAt` from before it still says when the last one did. */
  private forgetRegistrationTimes(): void {
    for (const [trunkId, current] of this.deps.state.trunks) {
      this.deps.state.trunks.set(trunkId, { ...current, registeredAt: null });
    }
  }

  /** Applies `changes`; with `registered`, each that leaves its trunk `registered` reports a
   * REGISTER that succeeded just now. */
  private apply(
    snapshot: Snapshot,
    changes: (StatusChange | null)[],
    registered = false
  ): void {
    for (const [trunkId, status] of onEnabledTransports(
      snapshot,
      this.deps.plainTransports,
      changes
    )) {
      this.setStatus(trunkId, status, registered && status === 'registered');
    }
  }

  private setStatus(
    trunkId: string,
    status: TrunkStatus,
    registered: boolean
  ): void {
    const current = this.deps.state.trunks.get(trunkId);
    const changed = current?.status !== status;
    if (!changed && !registered) {
      return;
    }
    const now = this.deps.now();
    this.deps.state.trunks.set(trunkId, {
      status,
      statusChangedAt: changed ? now : current.statusChangedAt,
      registeredAt: registered ? now : (current?.registeredAt ?? null)
    });
    if (changed) {
      this.deps.bus.emit({ type: 'trunk.status', trunkId, status });
    }
  }

  private async handleRegistry(event: AmiEvent): Promise<void> {
    const snapshot = await this.deps.cache.get();
    this.apply(snapshot, [registryEventStatus(snapshot, event)], true);
  }

  private async handleContactStatusChange(
    event: AriEventOf<'ContactStatusChange'>
  ): Promise<void> {
    const snapshot = await this.deps.cache.get();
    this.apply(snapshot, [contactEventStatus(snapshot, event)]);
  }
}
