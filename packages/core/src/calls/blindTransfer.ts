/**
 * Following a SIP `REFER` blind transfer (§10.1 "Transfers and pickup"): `BridgeBlindTransfer`
 * closes the transferrer's participation, and the onward call re-enters Stasis through
 * `from-users` as a new call with `parent_call_id` set to the original.
 *
 * Out of a bridge the core controls, Asterisk does not move the transferee. It swaps a Local
 * channel pair in for the transferrer (the event's `replace_channel`) and sends the pair's second
 * half into the dialplan, so the transferee stays in the original bridge with the pair's first
 * half, and the onward call's caller channel is the second half. That pair is the transferee's
 * line to the onward call: when either end of it goes, the other is hung up, as it would be if
 * the transferee's own channel had re-entered.
 */
import { ignoreGone, logFailure } from '../ari/failures.js';
import type { AriEvent, Channel } from '../ari/types.js';
import { closeCall } from './liveCall.js';
import {
  dropPendingTransfer,
  localDiallingHalf,
  setPendingTransfer
} from './pendingTransfer.js';
import type { Pipeline } from './pipeline.js';
import { fromOf, transfereeEntry, userOfChannel } from './transfers.js';

/** The transferee's channel and the Local half bridged with it, and the bridge they share. */
type LocalLine = { transfereeId: string; localId: string; bridgeId: string };

/** Each Local line, under both of its channel ids. */
type BlindState = { lines: Map<string, LocalLine> };

/**
 * `BridgeBlindTransfer`: the transferrer leaves `call`, which closes, and their channel, left
 * with nobody to talk to, is hung up. The onward call is announced to `handleOutbound` under the
 * channel that re-enters: the Local pair's dialling half when Asterisk replaced the transferrer
 * with one, else the transferee's own channel.
 */
async function onBlindTransfer(
  pipeline: Pipeline,
  state: BlindState,
  ev: AriEvent
): Promise<void> {
  const transferrer = ev.channel as Channel;
  const call = pipeline.callByChannel.get(transferrer.id);
  if (call === undefined) {
    return;
  }
  call.log.event({
    event: 'blindTransfer',
    channelId: transferrer.id,
    exten: ev.exten,
    result: ev.result
  });
  if (ev.result !== 'Success') {
    return;
  }
  const transferee = ev.transferee as Channel | undefined;
  const replacement = ev.replace_channel as Channel | undefined;
  const bridgeId = call.bridgeId;
  if (transferee !== undefined) {
    const snapshot = await pipeline.deps.cache.get();
    const diallingHalf =
      replacement === undefined ? null : localDiallingHalf(replacement.name);
    if (
      diallingHalf !== null &&
      replacement !== undefined &&
      bridgeId !== null
    ) {
      const line = {
        transfereeId: transferee.id,
        localId: replacement.id,
        bridgeId
      };
      state.lines.set(transferee.id, line);
      state.lines.set(replacement.id, line);
    }
    // §10.1: the onward call is routed as the transferrer's, so it carries their identity into
    // `handleOutbound` rather than the transferee's own (§9.4 route and caller-ID selection), and
    // its parent.
    setPendingTransfer(pipeline, diallingHalf ?? transferee.id, {
      parentCallId: call.id,
      transferrerUserId: userOfChannel(call, transferrer.id),
      transfereeUserId: userOfChannel(call, transferee.id),
      from: fromOf(call, transferee.id, snapshot),
      // The same row a transfer over the API gives the transferee (`transfers.ts`).
      ...transfereeEntry(call, transferee.id)
    });
  }
  await closeCall(pipeline, call, 'answered', false);
  await pipeline.deps.ari.channels.hangup(transferrer.id).catch(ignoreGone);
}

/** One end of a Local line went: the other end is hung up, and the bridge they shared destroyed. */
async function endLocalLine(
  pipeline: Pipeline,
  state: BlindState,
  channelId: string
): Promise<void> {
  const line = state.lines.get(channelId);
  if (line === undefined) {
    return;
  }
  state.lines.delete(line.transfereeId);
  state.lines.delete(line.localId);
  const { ari } = pipeline.deps;
  // The Local half's hangup ends its dialling half too, and with it the onward call.
  const other =
    channelId === line.transfereeId ? line.localId : line.transfereeId;
  await ari.channels.hangup(other).catch(ignoreGone);
  await ari.bridges.destroy(line.bridgeId).catch(ignoreGone);
}

/** Subscribes to `pipeline`'s ARI stream for the blind transfers Asterisk executes on `REFER`. */
export function followBlindTransfers(pipeline: Pipeline): void {
  const state: BlindState = { lines: new Map() };
  pipeline.deps.ari.on('event', (ev: AriEvent) => {
    if (ev.type === 'BridgeBlindTransfer') {
      onBlindTransfer(pipeline, state, ev).catch(
        logFailure(pipeline.deps.logger, 'blind transfer')
      );
      return;
    }
    const channel = ev.channel as Channel | undefined;
    if (channel === undefined) {
      return;
    }
    if (ev.type === 'ChannelDestroyed') {
      endLocalLine(pipeline, state, channel.id).catch(
        logFailure(pipeline.deps.logger, 'blind transfer line end')
      );
      // A transferee whose channel ended before it re-entered takes no onward call.
      dropPendingTransfer(pipeline, channel.id);
    }
  });
}
