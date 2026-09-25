/**
 * Trunk registration/reachability state (spec §9.4 "Provisioning and status"), resynced at boot
 * and followed by events: `ip` trunks from the ARI endpoint list and `ContactStatusChange` on the
 * first host's contact, `registration` trunks from the AMI `PJSIPShowRegistrationsOutbound`
 * action (at boot and on AMI reconnect) and `Registry` events; `trunkStatus.ts` reads each of
 * them as a status. Also the per-trunk active-channel count `outbound.ts`'s channel cap (§9.4
 * "Channels") reads, since nothing else in the process tracks it; it lives in the `StateStore`,
 * whose `trunkChannels` `api` exports in `/metrics` (§7).
 */
import type { AmiClient, AmiEvent } from '../ami/client.js';
import type { AriClient } from '../ari/client.js';
import type { AriEvent } from '../ari/types.js';
import type { ConfigCache, EventBus, StateStore } from '../internal/server.js';
import {
  contactEventStatus,
  endpointStatuses,
  registrationDetailStatuses,
  registrationTrunks,
  registryEventStatus,
  type StatusChange,
  type TrunkStatus
} from './trunkStatus.js';

export { outboundHosts, trunkSectionName } from './trunkStatus.js';

type TrunkStateDeps = {
  ari: AriClient;
  ami: AmiClient;
  cache: ConfigCache;
  state: StateStore;
  bus: EventBus;
  now: () => string;
};

export class TrunkState {
  private readonly deps: TrunkStateDeps;

  constructor(deps: TrunkStateDeps) {
    this.deps = deps;
    this.deps.ari.on('event', (event: AriEvent) => {
      if (event.type === 'ContactStatusChange') {
        this.handleContactStatusChange(event).catch(() => undefined);
      }
    });
    this.deps.ami.on('event', (event: AmiEvent) => {
      if (event.Event === 'Registry') {
        this.handleRegistry(event).catch(() => undefined);
      }
    });
    this.deps.ami.on('connected', () => {
      this.resyncRegistrations().catch(() => undefined);
    });
  }

  /** The trunk's currently active legs, inbound and outbound, for `channelCapAllows` (§9.4
   * "Channels"). */
  activeChannels(trunkId: string): number {
    return this.deps.state.trunkChannels.get(trunkId) ?? 0;
  }

  noteAttemptStarted(trunkId: string): void {
    this.deps.state.trunkChannels.set(
      trunkId,
      this.activeChannels(trunkId) + 1
    );
  }

  noteAttemptEnded(trunkId: string): void {
    const next = this.activeChannels(trunkId) - 1;
    // Kept in the live state, which `/metrics` reports (§7), so a trunk carrying none drops out.
    if (next > 0) {
      this.deps.state.trunkChannels.set(trunkId, next);
    } else {
      this.deps.state.trunkChannels.delete(trunkId);
    }
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
    let counted: string | null = null;
    const onEvent = (event: AriEvent): void => {
      const channel = event.channel as { id?: string } | undefined;
      if (event.type !== 'ChannelDestroyed' || channel?.id !== channelId) {
        return;
      }
      this.deps.ari.off('event', onEvent);
      destroyed = true;
      if (counted !== null) {
        this.noteAttemptEnded(counted);
      }
    };
    this.deps.ari.on('event', onEvent);
    return trunkId => {
      if (trunkId === null) {
        this.deps.ari.off('event', onEvent);
        return;
      }
      // A leg already gone never occupies a channel.
      if (!destroyed) {
        counted = trunkId;
        this.noteAttemptStarted(trunkId);
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
    this.apply(registrationDetailStatuses(snapshot, frames));
  }

  /**
   * Reads every `ip` trunk's reachability from the ARI endpoint list at boot: a `qualify` result
   * that came in while this process was down raises no `ContactStatusChange` for it to follow.
   */
  async resyncContacts(): Promise<void> {
    const snapshot = await this.deps.cache.get();
    this.apply(
      endpointStatuses(snapshot, await this.deps.ari.endpoints.list())
    );
  }

  private apply(changes: (StatusChange | null)[]): void {
    for (const change of changes) {
      if (change !== null) {
        this.setStatus(...change);
      }
    }
  }

  private setStatus(trunkId: string, status: TrunkStatus): void {
    const current = this.deps.state.trunks.get(trunkId);
    if (current?.status === status) {
      return;
    }
    this.deps.state.trunks.set(trunkId, {
      status,
      statusChangedAt: this.deps.now()
    });
    this.deps.bus.emit({ type: 'trunk.status', trunkId, status });
  }

  private async handleRegistry(event: AmiEvent): Promise<void> {
    const snapshot = await this.deps.cache.get();
    this.apply([registryEventStatus(snapshot, event)]);
  }

  private async handleContactStatusChange(event: AriEvent): Promise<void> {
    const snapshot = await this.deps.cache.get();
    this.apply([contactEventStatus(snapshot, event)]);
  }
}
