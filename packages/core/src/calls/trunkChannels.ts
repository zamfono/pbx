/**
 * The per-trunk active-channel count `routeSelection.ts`'s channel cap (§9.4 "Channels") reads,
 * since nothing else in the process tracks it; it lives in the `StateStore`, whose
 * `trunkChannels` `api` exports in `/metrics` (§7).
 */
import type { AriClient } from '../ari/client.js';
import type { StateStore } from '../internal/stateStore.js';
import { waitForEvent } from './ariWaits.js';

type TrunkChannelsDeps = {
  ari: AriClient;
  state: StateStore;
};

export class TrunkChannels {
  private readonly deps: TrunkChannelsDeps;
  // The trunk each counted leg's channel occupies, by channel: a leg ends once, however many of
  // its watchers see it end (an attempt hung up while its dial is in flight is seen by both).
  private readonly countedLegs = new Map<string, string>();

  constructor(deps: TrunkChannelsDeps) {
    this.deps = deps;
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
}
