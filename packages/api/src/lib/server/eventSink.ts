/**
 * The one hand-off between `api`'s two bundles (§3.1 "Events"). `server.ts` holds the `/events`
 * sockets, since a WebSocket upgrade never reaches SvelteKit; every event, `core`'s and the
 * backup jobs' alike, is produced in the SvelteKit bundle, where the background jobs run
 * (`jobs/background.ts`). Each bundle carries its own copy of this module, so the sink is kept
 * under a process-wide `Symbol.for` key they share: `server.ts` provides it before it loads the
 * SvelteKit handler, and the jobs publish to it.
 */
import type { Envelope } from '@zamfono/shared';

export type EventSink = (envelope: Envelope) => void;

const SINK_KEY = Symbol.for('zamfono.api.eventSink');

type SinkHolder = { [SINK_KEY]?: EventSink };

/** `server.ts`: every event published from now on reaches `sink`. */
export function provideEventSink(sink: EventSink): void {
  (globalThis as SinkHolder)[SINK_KEY] = sink;
}

/**
 * Hands `envelope` to the `/events` sockets; nothing without a `server.ts` (`vite dev`, tests),
 * where there are none to hand it to.
 */
export function publishEvent(envelope: Envelope): void {
  (globalThis as SinkHolder)[SINK_KEY]?.(envelope);
}
