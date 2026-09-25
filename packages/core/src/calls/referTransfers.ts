/**
 * The transfers Asterisk executes on SIP `REFER` (§10.1 "Transfers and pickup"): the softphone
 * sends the `REFER`, Asterisk carries it out, and `followTransfers` follows the
 * `BridgeBlindTransfer` (`blindTransfer.ts`) and `BridgeAttendedTransfer`
 * (`attendedTransfer.ts`) events it reports. The transfer `api` requests over the internal API
 * is `transfers.ts`'s.
 */
import type { AriEvent } from '../ari/types.js';
import { onAttendedTransfer } from './attendedTransfer.js';
import { followBlindTransfers } from './blindTransfer.js';
import type { Pipeline } from './pipeline.js';

/** Subscribes to `pipeline`'s ARI stream for the transfers Asterisk executes on SIP `REFER`. */
export function followTransfers(pipeline: Pipeline): void {
  followBlindTransfers(pipeline);
  pipeline.deps.ari.on('event', (ev: AriEvent) => {
    if (ev.type === 'BridgeAttendedTransfer') {
      onAttendedTransfer(pipeline, ev).catch(() => undefined);
    }
  });
}
