import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FRAME_MS, Playout } from './botPlayout.js';

const FRAME_BYTES = 4;

function playout(): {
  queue: Playout;
  frames: Buffer[];
  marks: unknown[];
  dropped: number[];
} {
  const frames: Buffer[] = [];
  const marks: unknown[] = [];
  const dropped: number[] = [];
  const queue = new Playout({
    frameBytes: FRAME_BYTES,
    send: frame => frames.push(frame),
    marked: marker => marks.push(marker),
    dropped: bytes => dropped.push(bytes)
  });
  return { queue, frames, marks, dropped };
}

// §9.4 "WebSocket targets": the bot's audio played at the call's own pace.
describe('Playout', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('sends one whole frame per 20 ms, padding the last with zeros, and silence with nothing queued', () => {
    const { queue, frames } = playout();
    queue.push(Buffer.from([1, 2, 3, 4, 5, 6]));
    queue.start();
    vi.advanceTimersByTime(0);
    expect(frames).toEqual([Buffer.from([1, 2, 3, 4])]);
    vi.advanceTimersByTime(FRAME_MS - 1);
    expect(frames).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(frames).toEqual([
      Buffer.from([1, 2, 3, 4]),
      Buffer.from([5, 6, 0, 0])
    ]);
    vi.advanceTimersByTime(FRAME_MS);
    expect(frames).toEqual([
      Buffer.from([1, 2, 3, 4]),
      Buffer.from([5, 6, 0, 0]),
      Buffer.alloc(FRAME_BYTES)
    ]);
    queue.stop();
  });

  it('echoes a marker once the audio before it has been sent, and at once with nothing queued', () => {
    const { queue, frames, marks } = playout();
    queue.mark('idle');
    expect(marks).toEqual(['idle']);
    queue.push(Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]));
    queue.mark('greeting');
    queue.push(Buffer.from([9, 9]));
    queue.start();
    vi.advanceTimersByTime(0);
    expect(marks).toEqual(['idle']);
    vi.advanceTimersByTime(FRAME_MS);
    expect(marks).toEqual(['idle', 'greeting']);
    // The audio after the marker starts a frame of its own.
    vi.advanceTimersByTime(FRAME_MS);
    expect(frames.at(-1)).toEqual(Buffer.from([9, 9, 0, 0]));
    queue.stop();
  });

  it('drops the queued audio on clear, handing back the markers dropped with it', () => {
    const { queue, frames, marks } = playout();
    queue.push(Buffer.alloc(FRAME_BYTES * 10, 1));
    queue.mark('a');
    queue.push(Buffer.alloc(FRAME_BYTES, 1));
    queue.mark('b');
    queue.start();
    vi.advanceTimersByTime(0);
    expect(queue.clear()).toEqual(['a', 'b']);
    vi.advanceTimersByTime(FRAME_MS * 5);
    expect(frames.slice(1)).toEqual(
      Array.from({ length: 5 }, () => Buffer.alloc(FRAME_BYTES))
    );
    expect(marks).toEqual([]);
    queue.stop();
  });

  it('drops audio beyond about a minute queued', () => {
    const { queue, dropped } = playout();
    const minute = (FRAME_BYTES * 60_000) / FRAME_MS;
    queue.push(Buffer.alloc(minute));
    queue.push(Buffer.alloc(FRAME_BYTES));
    expect(dropped).toEqual([FRAME_BYTES]);
  });

  it('keeps to the 20 ms clock however late a tick runs', () => {
    const { queue, frames } = playout();
    queue.push(Buffer.alloc(FRAME_BYTES * 10, 1));
    queue.start();
    vi.advanceTimersByTime(FRAME_MS * 5);
    // Ticks at 0, 20, 40, 60, 80 and 100 ms.
    expect(frames).toHaveLength(6);
    queue.stop();
    vi.advanceTimersByTime(FRAME_MS * 5);
    expect(frames).toHaveLength(6);
  });
});
