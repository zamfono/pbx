/** Waiting on ARI's event stream with a timeout: `waitForEvent` is the one primitive (subscribe,
 * settle once, unsubscribe), and the waits more than one flow shares are built on it. */
import type { AriClient } from '../ari/client.js';
import { isEvent, type AriEvent } from '../ari/events.js';

/**
 * One wait on the event stream: every event goes to its handler until the wait settles, and the
 * first `settle` resolves `promise`, unsubscribes and disarms the timeout; later ones do nothing.
 */
export class EventWait<T> {
  readonly promise: Promise<T>;
  private readonly resolve: (value: T) => void;
  private readonly ari: AriClient;
  private readonly onEvent: (ev: AriEvent, wait: EventWait<T>) => void;
  private settled = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private readonly listener = (ev: AriEvent): void => {
    this.onEvent(ev, this);
  };

  constructor(
    ari: AriClient,
    onEvent: (ev: AriEvent, wait: EventWait<T>) => void
  ) {
    const { promise, resolve } = Promise.withResolvers<T>();
    this.promise = promise;
    this.resolve = resolve;
    this.ari = ari;
    this.onEvent = onEvent;
    ari.on('event', this.listener);
  }

  settle(value: T): void {
    if (this.settled) {
      return;
    }
    this.settled = true;
    this.ari.off('event', this.listener);
    this.disarm();
    this.resolve(value);
  }

  /** Arms the timeout, replacing any armed one: `onTimeout` runs once `ms` pass. */
  arm(ms: number, onTimeout: () => void): void {
    this.disarm();
    if (this.settled) {
      return;
    }
    this.timer = setTimeout(onTimeout, ms);
    this.timer.unref();
  }

  disarm(): void {
    clearTimeout(this.timer);
  }
}

/** Subscribes `onEvent` to `ari`'s event stream until the returned wait settles. */
export function waitForEvent<T>(
  ari: AriClient,
  onEvent: (ev: AriEvent, wait: EventWait<T>) => void
): EventWait<T> {
  return new EventWait(ari, onEvent);
}

/** Whether `ev` ends `channelId`'s part in the app: its `StasisEnd` or `ChannelDestroyed`. */
export function channelLeft(ev: AriEvent, channelId: string): boolean {
  return (
    (ev.type === 'ChannelDestroyed' || ev.type === 'StasisEnd') &&
    ev.channel?.id === channelId
  );
}

/** Whether `ev` is the `PlaybackFinished` of `playbackId`. */
export function playbackFinished(ev: AriEvent, playbackId: string): boolean {
  return isEvent(ev, 'PlaybackFinished') && ev.playback.id === playbackId;
}

/** The end of the recording `name` that `ev` reports: its duration in seconds once finished,
 * `null` once failed, `undefined` for any other event. */
export function recordingEnd(
  ev: AriEvent,
  name: string
): number | null | undefined {
  if (
    !isEvent(ev, 'RecordingFinished', 'RecordingFailed') ||
    ev.recording.name !== name
  ) {
    return undefined;
  }
  return ev.type === 'RecordingFinished' ? (ev.recording.duration ?? 0) : null;
}

/** Waits for the recording named `name` to end: its reported duration, or `null` once it failed
 * or `timeoutMs` passed. Subscribe before the request that ends it, so its end cannot slip past. */
export function waitForRecording(
  ari: AriClient,
  name: string,
  timeoutMs: number
): Promise<number | null> {
  const wait = waitForEvent<number | null>(ari, (ev, waiting) => {
    const end = recordingEnd(ev, name);
    if (end !== undefined) {
      waiting.settle(end);
    }
  });
  wait.arm(timeoutMs, () => {
    wait.settle(null);
  });
  return wait.promise;
}

/** How a Stasis-entry wait ended. */
export type StasisEntry = 'entered' | 'gone' | 'timeout';

/** Waits for the channel `channelId` to enter the app: `entered` on its `StasisStart`, `gone` on
 * its `ChannelDestroyed`, `timeout` once `timeoutMs` pass. Subscribe before the channel is
 * created, since its `StasisStart` may precede the create's answer; settle it `gone` for a
 * channel never created. */
export function waitForStasisEntry(
  ari: AriClient,
  channelId: string,
  timeoutMs: number
): EventWait<StasisEntry> {
  const wait = waitForEvent<StasisEntry>(ari, (ev, waiting) => {
    if (ev.channel?.id !== channelId) {
      return;
    }
    if (ev.type === 'StasisStart') {
      waiting.settle('entered');
    } else if (ev.type === 'ChannelDestroyed') {
      waiting.settle('gone');
    }
  });
  wait.arm(timeoutMs, () => {
    wait.settle('timeout');
  });
  return wait;
}
