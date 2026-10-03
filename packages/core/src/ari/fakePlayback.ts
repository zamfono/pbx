// FakeAri's playbacks: each one acked at once and finished after a delay, unless a barge-in stops
// it first.
import { randomUUID } from 'node:crypto';

import { HTTP_OK } from '@zamfono/shared';

import type { AriEvent } from './events.js';
import type { RouteResult } from './fakeHttp.js';

/** The slice of `FakeAri` a playback drives. */
export type PlaybackHost = {
  playbackFinishedAfterMs: number;
  emit: (event: AriEvent) => void;
};

export class FakePlaybacks {
  private readonly host: PlaybackHost;
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(host: PlaybackHost) {
    this.host = host;
  }

  /** `POST /channels/{id}/play`: acks with the playback id (the caller's own `playbackId` when
   * given, matching real ARI) and emits `PlaybackFinished` for it after `playbackFinishedAfterMs`. */
  start(body: unknown): RouteResult {
    const params = body as { playbackId?: string } | undefined;
    const id = params?.playbackId ?? randomUUID();
    const timer = setTimeout(() => {
      this.timers.delete(id);
      this.host.emit({
        type: 'PlaybackFinished',
        timestamp: new Date().toISOString(),
        application: 'zamfono',
        playback: { id }
      });
    }, this.host.playbackFinishedAfterMs);
    timer.unref();
    this.timers.set(id, timer);
    return { status: HTTP_OK, body: { id } };
  }

  /** `DELETE /playbacks/{id}`: cancels the pending `PlaybackFinished` a barge-in stopped early. */
  stop(id: string): RouteResult {
    const timer = this.timers.get(id);
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(id);
    }
    return { status: HTTP_OK, body: {} };
  }

  /** Cancels every pending `PlaybackFinished`, as the fake shuts down. */
  clear(): void {
    for (const timer of this.timers.values()) {
      clearTimeout(timer);
    }
    this.timers.clear();
  }
}
