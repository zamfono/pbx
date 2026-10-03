/**
 * The transfers Asterisk executes on SIP `REFER` (§10.1 "Transfers and pickup"): the softphone
 * sends the `REFER`, Asterisk carries it out, and `followTransfers` follows the
 * `BridgeBlindTransfer` (`blindTransfer.ts`) and `BridgeAttendedTransfer`
 * (`attendedTransfer.ts`) events it reports. The transfer `api` requests over the internal API
 * is `transfers.ts`'s.
 */
import { isEvent, type AriEvent } from '../ari/events.js';
import { logFailure } from '../ari/failures.js';
import { onAttendedTransfer } from './attendedTransfer.js';
import { followBlindTransfers } from './blindTransfer.js';
import type { Pipeline } from './pipeline.js';

/** Subscribes to `pipeline`'s ARI stream for the transfers Asterisk executes on SIP `REFER`. */
export function followTransfers(pipeline: Pipeline): void {
  followBlindTransfers(pipeline);
  pipeline.deps.ari.on('event', (ev: AriEvent) => {
    if (isEvent(ev, 'BridgeAttendedTransfer')) {
      onAttendedTransfer(pipeline, ev).catch(
        logFailure(pipeline.deps.logger, 'attended transfer')
      );
    }
  });
}
