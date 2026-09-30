/**
 * The events of a channel the core places that arrive before its placement returns (created, then
 * dialled, `legOriginate.ts`). Asterisk dials the channel while it answers the dial request, so a
 * far end that answers or refuses at once (a trunk's 403, a phone's 486, within milliseconds) can
 * have its `ChannelStateChange` or `ChannelDestroyed` reach the core before anything tracks the
 * channel's id, and every listener keyed by that id drops it. Recording the stream from before the
 * create lets those events be handled once the channel is tracked (§9.4 "Route fallthrough", §10.1 steps 4 and 5).
 */
import type { AriClient } from '../ari/client.js';
import type { AriEvent, Channel } from '../ari/types.js';

/** The ARI events received since `recordEvents` was called, until `stop`. */
export type EventRecording = { events: AriEvent[]; stop: () => void };

/** Records every ARI event from now on, until `stop`. */
export function recordEvents(ari: AriClient): EventRecording {
  const events: AriEvent[] = [];
  const onEvent = (event: AriEvent): void => {
    events.push(event);
  };
  ari.on('event', onEvent);
  return {
    events,
    stop: () => {
      ari.off('event', onEvent);
    }
  };
}

/** Whether `event` is about `channelId`: the channel's own, or a `Dial` whose peer it is. */
function concerns(event: AriEvent, channelId: string): boolean {
  const channel = (event.type === 'Dial' ? event.peer : event.channel) as
    Channel | undefined;
  return channel?.id === channelId;
}

/**
 * Stops `recording` and hands its events about `channelId` to every listener of `ari` again, now
 * that the channel is tracked. Called in the same tick as the tracking, so no event falls between
 * the recording and the listeners. A listener saw each of them once already, while nothing knew
 * the channel, and passed over it as it does any channel it does not track.
 */
export function redeliverEarlyEvents(
  ari: AriClient,
  recording: EventRecording,
  channelId: string
): void {
  recording.stop();
  for (const event of recording.events) {
    if (concerns(event, channelId)) {
      ari.emit('event', event);
    }
  }
}
