/**
 * The Asterisk side of one recorded participation (§10.2 "Call recording"): the snoop channel
 * recording one direction of a leg and Asterisk's `RecordingFinished` for it. Its own module so
 * `recording.ts`, which tracks the participations, stays one responsibility; the ffmpeg mix is
 * `recordingMix.ts`.
 */
import { rm } from 'node:fs/promises';

import { newId } from '@zamfono/shared';

import type { AriClient } from '../ari/client.js';
import { logFailure, logUnlessGone } from '../ari/failures.js';
import type { AriEvent, Channel } from '../ari/types.js';
import type { RecordFormat } from './recordingRate.js';

// ARI's `record()` has no natural cap for a call recording (unlike voicemail's
// `voicemail_max_s`): the snoop channel's own hangup, in `onLegEnded`, is what ends it.
const RECORD_NO_MAX_DURATION_S = 0;
const RECORD_NO_SILENCE_STOP_S = 0;
// Best effort (§10.2): if Asterisk's `RecordingFinished` never arrives for a snoop recording, the
// mix goes ahead after this rather than hanging forever.
const RECORDING_FINISHED_TIMEOUT_MS = 5000;
// A snoop channel enters Stasis within milliseconds of its creation; one that has not within this
// is taken to have failed, and the participation goes unrecorded (§10.2 "Best effort").
const SNOOP_STASIS_TIMEOUT_MS = 2000;

/** Waits for Asterisk's `RecordingFinished` event for the snoop recording named `name` (§10.2):
 * its file is closed, and the mix can read it. The event's own `duration` is not used — Asterisk
 * divides the samples by 8000 whatever the format, doubling a `wav16` recording's — the mix
 * measures the file instead (`recordingMix.ts`). */
export function waitForRecordingFinished(
  ari: AriClient,
  name: string
): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<undefined>();
  const onEvent = (ev: AriEvent): void => {
    const recording = ev.recording as { name?: string } | undefined;
    if (ev.type === 'RecordingFinished' && recording?.name === name) {
      resolve(undefined);
    }
  };
  ari.on('event', onEvent);
  const timer = setTimeout(() => {
    resolve(undefined);
  }, RECORDING_FINISHED_TIMEOUT_MS);
  timer.unref();
  return promise.finally(() => {
    ari.off('event', onEvent);
    clearTimeout(timer);
  });
}

/** A wait for a channel's `StasisStart`, and its cancellation for a channel never created. */
type StasisWait = { entered: Promise<boolean>; cancel: () => void };

/** Waits for the channel `channelId` to enter the Stasis application: `true` once it has,
 * `false` if it is destroyed first or `timeoutMs` passes. Subscribed before the channel exists,
 * so its `StasisStart` cannot slip past, however early Asterisk sends it. */
function waitForStasisStart(
  ari: AriClient,
  channelId: string,
  timeoutMs: number
): StasisWait {
  const { promise, resolve } = Promise.withResolvers<boolean>();
  const onEvent = (ev: AriEvent): void => {
    if ((ev.channel as Channel | undefined)?.id !== channelId) {
      return;
    }
    if (ev.type === 'StasisStart') {
      resolve(true);
    } else if (ev.type === 'ChannelDestroyed') {
      resolve(false);
    }
  };
  ari.on('event', onEvent);
  const timer = setTimeout(() => {
    resolve(false);
  }, timeoutMs);
  timer.unref();
  const entered = promise.finally(() => {
    ari.off('event', onEvent);
    clearTimeout(timer);
  });
  return {
    entered,
    cancel: () => {
      resolve(false);
    }
  };
}

// Asterisk's snoop `spy` direction is from the channel's own perspective: `in` is what
// Asterisk reads from it, the participant's own voice (left, §10.2 "Channels and stereo
// mapping"); `out` is what Asterisk writes to it, everything the participant heard (right).
// The snoop channel is created into the `zamfono` application, but Asterisk answers the snoop
// request before the channel has entered it, and refuses a `record` on a channel outside Stasis
// (409 "Channel not in Stasis application"): the recording waits for its `StasisStart`.
async function startSnoop(
  ari: AriClient,
  channelId: string,
  spy: 'in' | 'out',
  name: string,
  format: RecordFormat
): Promise<string> {
  const snoopId = newId();
  const stasis = waitForStasisStart(ari, snoopId, SNOOP_STASIS_TIMEOUT_MS);
  try {
    await ari.channels.snoop(channelId, {
      spy,
      whisper: 'none',
      app: 'zamfono',
      appArgs: `snoop,${channelId}`,
      snoopId
    });
  } catch (error) {
    stasis.cancel();
    throw error;
  }
  try {
    if (!(await stasis.entered)) {
      throw new Error('snoop channel never entered Stasis');
    }
    await ari.channels.record(snoopId, {
      name,
      format,
      maxDurationSeconds: RECORD_NO_MAX_DURATION_S,
      maxSilenceSeconds: RECORD_NO_SILENCE_STOP_S,
      terminateOn: 'none'
    });
  } catch (error) {
    // A snoop channel that records nothing must not outlive the failure.
    await ari.channels
      .hangup(snoopId)
      .catch(logUnlessGone(ari.log, 'snoop hangup'));
    throw error;
  }
  return snoopId;
}

/** One direction of a participation: the recording's ARI name and the raw file it writes. */
export type SnoopHalf = { name: string; file: string };

/** A participation's snoop pair, recording in `format` (§10.2 "Sample rate"). */
export type SnoopPair = {
  left: SnoopHalf;
  right: SnoopHalf;
  format: RecordFormat;
};

/**
 * Starts the snoop pair on `channelId`, `left` spying `in` and `right` `out`, and returns their
 * channel ids. A pair that cannot start leaves no half of itself behind (§10.2 "Best effort"):
 * the half already recording is hung up and, once Asterisk has finished its file, that raw file
 * is removed — a pair with no row would otherwise sit on disk until the retention sweep.
 */
export async function startSnoopPair(
  ari: AriClient,
  channelId: string,
  { left, right, format }: SnoopPair
): Promise<[string, string]> {
  const leftId = await startSnoop(ari, channelId, 'in', left.name, format);
  try {
    return [
      leftId,
      await startSnoop(ari, channelId, 'out', right.name, format)
    ];
  } catch (error) {
    const finished = waitForRecordingFinished(ari, left.name);
    await ari.channels
      .hangup(leftId)
      .catch(logUnlessGone(ari.log, 'snoop hangup'));
    // Not awaited: the file goes once Asterisk has closed it, without holding up the call.
    finished
      .then(() =>
        Promise.all(
          [left.file, right.file].map(file => rm(file, { force: true }))
        )
      )
      .catch(logFailure(ari.log, 'snoop file removal'));
    throw error;
  }
}
