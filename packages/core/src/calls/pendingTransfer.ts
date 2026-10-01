/**
 * What a blind transfer's onward call needs before it routes (§10.1 "Transfers and pickup"), one
 * entry per transfer, held by the `Pipeline` until the onward call takes it.
 *
 * The onward call re-enters Stasis through `from-users` as an ordinary outbound call. Several
 * things about it come from the transfer rather than from the channel: it is a child of the
 * original call, its caller is the transferee, and — since §10.1 routes a transfer to an external
 * number as the transferrer's call (§9.4) — the identity it dials as is the transferrer's. All
 * are read when the call is built, because the routes, caller-ID and CLIR that identity selects
 * are chosen there.
 *
 * The channel that re-enters is keyed two ways. A transferee redirected into the dialplan
 * re-enters as itself, keyed by its channel id. A transferee in a bridge the core controls stays
 * in that bridge: Asterisk swaps a Local channel pair in for the transferrer and sends the pair's
 * second half into the dialplan (ARI's `replace_channel`), so that half is keyed by its name. Its
 * `StasisStart` can arrive before the `BridgeBlindTransfer` that describes it, so a Local
 * channel's entry is waited for.
 */
import type { Channel } from '../ari/types.js';
import type { Pipeline } from './pipeline.js';

export type PendingTransfer = {
  parentCallId: string;
  /** The user whose routes, caller-ID and CLIR the onward call uses; `null` for an outside party. */
  transferrerUserId: string | null;
  /** The transferee, the onward call's caller: their user, `null` for an outside party. */
  transfereeUserId: string | null;
  /** The number the onward call is from: the transferee's. */
  from: string;
  /** Whether the onward call continues an inbound call, and through which DID (`transfereeEntry`). */
  inbound: boolean;
  didId: string | null;
};

// How long a Local channel's `StasisStart` waits for the `BridgeBlindTransfer` naming it. Both
// leave Asterisk within the same millisecond; the budget only has to cover the core's own turns.
const LOCAL_TRANSFER_WAIT_MS = 2000;

/** The `Pipeline`'s pending transfers: each entry by the key its channel re-enters under, and the
 * Local channels already waiting for theirs. */
export type PendingTransfers = {
  entries: Map<string, PendingTransfer>;
  waiters: Map<string, (pending: PendingTransfer) => void>;
};

/** The dialling half of the Local pair whose first half is named `firstHalf` (`…;1` → `…;2`). */
export function localDiallingHalf(firstHalf: string): string | null {
  return firstHalf.startsWith('Local/') && firstHalf.endsWith(';1')
    ? `${firstHalf.slice(0, -1)}2`
    : null;
}

function isLocalDiallingHalf(name: string): boolean {
  return name.startsWith('Local/') && name.endsWith(';2');
}

/** Records what the re-entering channel, by id or by Local name, carries into its own call. */
export function setPendingTransfer(
  pipeline: Pipeline,
  key: string,
  pending: PendingTransfer
): void {
  const registry = pipeline.pendingTransfers;
  const waiter = registry.waiters.get(key);
  if (waiter !== undefined) {
    registry.waiters.delete(key);
    waiter(pending);
    return;
  }
  registry.entries.set(key, pending);
}

function takeEntry(
  registry: PendingTransfers,
  key: string
): PendingTransfer | null {
  const pending = registry.entries.get(key);
  if (pending === undefined) {
    return null;
  }
  registry.entries.delete(key);
  return pending;
}

/**
 * Reads and clears `channel`'s entry; `null` for a channel that is not a transferee. A Local
 * pair's dialling half waits for its entry, since Asterisk creates such a pair for nothing but a
 * transfer out of a bridge the core controls.
 */
export async function takePendingTransfer(
  pipeline: Pipeline,
  channel: Pick<Channel, 'id' | 'name'>
): Promise<PendingTransfer | null> {
  const registry = pipeline.pendingTransfers;
  const byId = takeEntry(registry, channel.id);
  if (byId !== null || !isLocalDiallingHalf(channel.name)) {
    return byId;
  }
  const byName = takeEntry(registry, channel.name);
  if (byName !== null) {
    return byName;
  }
  return new Promise(resolve => {
    const timer = setTimeout(() => {
      registry.waiters.delete(channel.name);
      resolve(null);
    }, LOCAL_TRANSFER_WAIT_MS);
    timer.unref();
    registry.waiters.set(channel.name, pending => {
      clearTimeout(timer);
      resolve(pending);
    });
  });
}

/** Drops `key`'s entry, for a transferee whose channel ended before it re-entered. */
export function dropPendingTransfer(pipeline: Pipeline, key: string): void {
  pipeline.pendingTransfers.entries.delete(key);
}
