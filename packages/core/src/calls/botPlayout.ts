/**
 * The audio a voice bot sends, played into the call at its own pace (§9.4 "WebSocket targets"):
 * a bot sends faster than real time, so its audio is queued and sent one 20 ms frame per tick,
 * as Asterisk expects it, and silence on a tick with nothing queued: Asterisk 22's AudioSocket
 * channel waits for the next message with the channel locked, so a stream that goes quiet would
 * hold it, and every bridge and ARI request touching it, until the bot spoke again. A marker the bot sets (Twilio's `mark`, Vonage's `notify`) waits
 * in the queue behind the audio sent before it and is echoed once that has been sent; one set
 * with nothing queued is echoed at once. `clear` drops the queued audio and hands back the
 * markers dropped with it.
 */

/** The interval Asterisk frames audio in, and the one the queue is played at. */
export const FRAME_MS = 20;
/** The most audio queued at once, about a minute, as a Vonage call buffers it; beyond it the
 * bot's audio is dropped. */
const MAX_QUEUED_MS = 60_000;

type Item = { audio: Buffer } | { marker: unknown };

export type PlayoutDeps = {
  /** Bytes of one frame of the call's signed linear audio, a short last one padded with zeros. */
  frameBytes: number;
  send: (frame: Buffer) => void;
  marked: (marker: unknown) => void;
  /** Audio dropped on a full queue, in bytes. */
  dropped: (bytes: number) => void;
};

export class Playout {
  private readonly deps: PlayoutDeps;
  private readonly maxBytes: number;
  private items: Item[] = [];
  private queuedBytes = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  /** When the next frame is due, in `Date.now()` milliseconds, `null` while stopped. */
  private due: number | null = null;

  constructor(deps: PlayoutDeps) {
    this.deps = deps;
    this.maxBytes = (deps.frameBytes * MAX_QUEUED_MS) / FRAME_MS;
  }

  /** Queues `audio`, or drops it while the queue is full. */
  push(audio: Buffer): void {
    if (this.queuedBytes + audio.length > this.maxBytes) {
      this.deps.dropped(audio.length);
      return;
    }
    this.items.push({ audio });
    this.queuedBytes += audio.length;
  }

  /** Queues `marker` behind the audio queued so far, echoing it at once when there is none. */
  mark(marker: unknown): void {
    if (this.items.length === 0) {
      this.deps.marked(marker);
      return;
    }
    this.items.push({ marker });
  }

  /** Drops every queued item, returning the markers among them. */
  clear(): unknown[] {
    const markers = this.items.flatMap(item =>
      'marker' in item ? [item.marker] : []
    );
    this.items = [];
    this.queuedBytes = 0;
    return markers;
  }

  /** Starts the frame clock. */
  start(): void {
    if (this.due === null) {
      this.due = Date.now();
      this.schedule();
    }
  }

  /** Stops the frame clock; what is queued stays unsent. */
  stop(): void {
    clearTimeout(this.timer);
    this.due = null;
  }

  /** Arms the next tick for `due`, so the clock keeps to 20 ms however late a tick runs. */
  private schedule(): void {
    if (this.due === null) {
      return;
    }
    this.timer = setTimeout(
      () => {
        this.tick();
      },
      Math.max(0, this.due - Date.now())
    );
    this.timer.unref();
  }

  private tick(): void {
    if (this.due === null) {
      return;
    }
    this.due += FRAME_MS;
    this.deps.send(this.takeFrame());
    this.echoMarkers();
    this.schedule();
  }

  /** The next frame: the queued audio up to the next marker, padded to a whole frame. */
  private takeFrame(): Buffer {
    const frame = Buffer.alloc(this.deps.frameBytes);
    let filled = 0;
    while (filled < frame.length) {
      const head = this.items[0];
      if (head === undefined || !('audio' in head)) {
        break;
      }
      const taken = head.audio.copy(frame, filled);
      filled += taken;
      this.queuedBytes -= taken;
      if (taken === head.audio.length) {
        this.items.shift();
      } else {
        head.audio = head.audio.subarray(taken);
      }
    }
    return frame;
  }

  /** Echoes the markers at the head of the queue, whose audio has all been sent. */
  private echoMarkers(): void {
    for (
      let head = this.items[0];
      head !== undefined && 'marker' in head;
      head = this.items[0]
    ) {
      this.items.shift();
      this.deps.marked(head.marker);
    }
  }
}
