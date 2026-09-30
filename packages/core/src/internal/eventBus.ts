/**
 * `core`'s in-process event fan-out (§3.1 "Events"): everything that emits an event, and the
 * internal `/internal/events` stream `api` subscribes to.
 */
import {
  newId,
  nowIso,
  type AsteriskStartedFrame,
  type CoreStreamFrame,
  type Envelope,
  type Event
} from '@zamfono/shared';

/**
 * Wraps every core-produced `Event` into an `Envelope` and fans it out to subscribers; the
 * internal stream's subscribers also receive the frames meant for `api` alone (`announce`).
 */
export class EventBus {
  private readonly subscribers = new Set<(envelope: Envelope) => void>();
  private readonly streamSubscribers = new Set<
    (frame: CoreStreamFrame) => void
  >();

  emit(event: Event): Envelope {
    const envelope: Envelope = { ...event, id: newId(), at: nowIso() };
    for (const subscriber of this.subscribers) {
      subscriber(envelope);
    }
    for (const subscriber of this.streamSubscribers) {
      subscriber(envelope);
    }
    return envelope;
  }

  /** Sends `frame` to the internal stream only: it is no event, and no in-process subscriber's. */
  announce(frame: AsteriskStartedFrame): void {
    for (const subscriber of this.streamSubscribers) {
      subscriber(frame);
    }
  }

  subscribe(fn: (envelope: Envelope) => void): () => void {
    this.subscribers.add(fn);
    return () => {
      this.subscribers.delete(fn);
    };
  }

  /** Every frame of the internal stream: each `Envelope` and each `announce`d frame. */
  subscribeStream(fn: (frame: CoreStreamFrame) => void): () => void {
    this.streamSubscribers.add(fn);
    return () => {
      this.streamSubscribers.delete(fn);
    };
  }
}
