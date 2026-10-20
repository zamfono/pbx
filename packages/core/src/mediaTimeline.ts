/**
 * The media timeline of level `qos` (§7): while a call runs, each of its channels that carries
 * its media (`qosTargets`) is sampled over ARI every few seconds, and at once on the events that
 * change where its media goes (a bridge joined or left, a transfer, the core closing the call),
 * each sample one `media` line in the call's log. `cdr.ts`'s `CdrWriter` owns it.
 *
 * A sample holds the packets the channel's RTP instance sent and received since the channel's
 * previous sample, the remote address its RTP goes to (which symmetric RTP takes from the
 * packets that arrive) and Asterisk's own local one, both SSRCs, whether the stream is encrypted
 * and whether it or the channel is held, its native, read and write formats, and the bridge it is
 * in with that bridge's technology. A channel with nothing to read and in no bridge is gone, and
 * has no sample.
 */
import type { CallLogLevel } from '@zamfono/shared';

import { logFailure } from './ari/failures.js';
import type { BridgesApi, ChannelsApi, Logger } from './ari/types.js';
import type { Call } from './calls/call.js';
import { formatNames } from './calls/codecTrace.js';
import { qosTargets } from './qosTargets.js';

// §7: the timeline is level `qos`'s, and `sip` adds to it; below, no channel is read.
const TIMELINE_LEVELS: ReadonlySet<CallLogLevel> = new Set(['qos', 'sip']);

const SAMPLE_INTERVAL_MS = 2000;

/** The channel functions a sample reads, by the field each fills (chan_pjsip's `rtcp` and `rtp`
 * types of `CHANNEL()`; the hold state and the formats are any channel's). */
const READS = {
  sent: 'CHANNEL(rtcp,txcount)',
  received: 'CHANNEL(rtcp,rxcount)',
  rtpDest: 'CHANNEL(rtp,dest)',
  rtpSrc: 'CHANNEL(rtp,src)',
  localSsrc: 'CHANNEL(rtcp,local_ssrc)',
  remoteSsrc: 'CHANNEL(rtcp,remote_ssrc)',
  secure: 'CHANNEL(rtp,secure)',
  rtpHold: 'CHANNEL(rtp,hold)',
  onHold: 'CHANNEL(onhold)',
  nativeFormat: 'CHANNEL(audionativeformat)',
  readFormat: 'CHANNEL(audioreadformat)',
  writeFormat: 'CHANNEL(audiowriteformat)'
} as const;

type Reads = Record<keyof typeof READS, string | null>;

type Counters = { sent: number; received: number };

/** A `1`/`0` flag Asterisk printed, `undefined` for none. */
function flag(value: string | null): boolean | undefined {
  return value === null ? undefined : value === '1';
}

/** A count Asterisk printed, `null` for none. */
function count(value: string | null): number | null {
  const parsed = value === null ? Number.NaN : Number(value);
  return Number.isInteger(parsed) ? parsed : null;
}

export class MediaTimeline {
  private readonly ari: {
    channels: Pick<ChannelsApi, 'getVariable'>;
    bridges: Pick<BridgesApi, 'list'>;
  };
  private readonly log: Logger;
  private readonly now: () => string;
  private readonly intervalMs: number;
  /** The calls open now, which each tick samples. */
  private readonly open = new Set<Call>();
  /** Each channel's counters as of its latest sample, until it ends. */
  private readonly counters = new Map<string, Counters>();
  /** Settles once each call's samples in flight have, which its log waits for (`settled`). */
  private readonly pending = new Map<Call, Promise<unknown>>();
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    ari: MediaTimeline['ari'],
    log: Logger,
    now: () => string,
    intervalMs = SAMPLE_INTERVAL_MS
  ) {
    this.ari = ari;
    this.log = log;
    this.now = now;
    this.intervalMs = intervalMs;
  }

  /** `call` is open: each tick samples it from now on, once its level is `qos`. */
  track(call: Call): void {
    this.open.add(call);
    if (this.timer === null) {
      this.timer = setInterval(() => {
        this.sample(this.open).catch(logFailure(this.log, 'media sample'));
      }, this.intervalMs);
      this.timer.unref();
    }
  }

  /** `call` is ending: no tick samples it again, and this resolves once its samples in flight are
   * in its log. */
  async settled(call: Call): Promise<void> {
    this.open.delete(call);
    if (this.open.size === 0 && this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    await this.pending.get(call);
    this.pending.delete(call);
  }

  /** `channelId` has ended: its counters go with it. */
  forget(channelId: string): void {
    this.counters.delete(channelId);
  }

  /**
   * Samples the channels of the open `calls` at level `qos` or above now, each once whichever of
   * them it is in, and logs each sample to each of those calls, with `on` naming what prompted it
   * (none for a tick). A failed read leaves the whole sample out.
   */
  sample(calls: Iterable<Call | undefined>, on?: string): Promise<void> {
    const callsByChannel = new Map<string, Call[]>();
    for (const call of new Set(calls)) {
      if (
        call === undefined ||
        !this.open.has(call) ||
        !TIMELINE_LEVELS.has(call.log.level)
      ) {
        continue;
      }
      for (const { channelId } of qosTargets(call)) {
        callsByChannel.set(channelId, [
          ...(callsByChannel.get(channelId) ?? []),
          call
        ]);
      }
    }
    if (callsByChannel.size === 0) {
      return Promise.resolve();
    }
    const done = this.read([...callsByChannel.keys()]).then(samples => {
      for (const [channelId, line] of samples) {
        for (const call of callsByChannel.get(channelId) ?? []) {
          call.log.event({ event: 'media', on, ...line });
        }
      }
    });
    for (const call of new Set([...callsByChannel.values()].flat())) {
      this.pending.set(
        call,
        Promise.allSettled([this.pending.get(call) ?? Promise.resolve(), done])
      );
    }
    return done;
  }

  /** Each of `channelIds` that is not gone, with its sample's line. */
  private async read(
    channelIds: string[]
  ): Promise<Map<string, Record<string, unknown>>> {
    const [bridges, ...reads] = await Promise.all([
      this.ari.bridges.list(),
      ...channelIds.map(async channelId => this.readChannel(channelId))
    ]);
    const at = this.now();
    const samples = new Map<string, Record<string, unknown>>();
    channelIds.forEach((channelId, index) => {
      const values = reads[index];
      const bridge = bridges.find(({ channels }) =>
        channels.includes(channelId)
      );
      if (
        values === undefined ||
        (bridge === undefined &&
          Object.values(values).every(value => value === null))
      ) {
        return;
      }
      samples.set(channelId, {
        at,
        channelId,
        ...this.deltas(channelId, values),
        rtpSrc: values.rtpSrc ?? undefined,
        rtpDest: values.rtpDest ?? undefined,
        localSsrc: values.localSsrc ?? undefined,
        remoteSsrc: values.remoteSsrc ?? undefined,
        secure: flag(values.secure),
        rtpHold: flag(values.rtpHold),
        onHold: flag(values.onHold),
        nativeFormat: formatNames(values.nativeFormat) ?? undefined,
        readFormat: values.readFormat ?? undefined,
        writeFormat: values.writeFormat ?? undefined,
        bridgeId: bridge?.id,
        bridgeTechnology: bridge?.technology
      });
    });
    return samples;
  }

  private async readChannel(channelId: string): Promise<Reads> {
    const entries = await Promise.all(
      Object.entries(READS).map(
        async ([field, name]) =>
          [field, await this.ari.channels.getVariable(channelId, name)] as const
      )
    );
    return Object.fromEntries(entries) as Reads;
  }

  /**
   * The packets sent and received since `channelId`'s previous sample. Two samples in flight at
   * once may read in either order, so a counter is only ever taken forward.
   */
  private deltas(
    channelId: string,
    values: Reads
  ): { sent?: number; received?: number } {
    const previous = this.counters.get(channelId) ?? { sent: 0, received: 0 };
    const sent = count(values.sent);
    const received = count(values.received);
    this.counters.set(channelId, {
      sent: Math.max(previous.sent, sent ?? 0),
      received: Math.max(previous.received, received ?? 0)
    });
    return {
      ...(sent === null ? {} : { sent: Math.max(0, sent - previous.sent) }),
      ...(received === null
        ? {}
        : { received: Math.max(0, received - previous.received) })
    };
  }
}
