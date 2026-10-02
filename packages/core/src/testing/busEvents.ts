import type { Envelope } from '@zamfono/shared';

import type { EventBus } from '../internal/eventBus.js';

/** Calls `fn` with every event `bus` emits, the internal stream's frames for `api` alone left
 * out; returns the unsubscribe. */
export function onEvents(
  bus: EventBus,
  fn: (envelope: Envelope) => void
): () => void {
  return bus.subscribeStream(frame => {
    if (frame.type !== 'asterisk.started') {
      fn(frame);
    }
  });
}
