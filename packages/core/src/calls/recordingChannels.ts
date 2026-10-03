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
import { waitForRecording, waitForStasisEntry } from './ariWaits.js';
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

/** Waits for the end of the snoop recording named `name` (§10.2): its file is closed, and the mix
 * can read it. The event's own `duration` is not used — Asterisk divides the samples by 8000
 * whatever the format, doubling a `wav16` recording's — the mix measures the file instead
 * (`recordingMix.ts`). */
export async function waitForRecordingFinished(
  ari: AriClient,
  name: string
): Promise<void> {
  await waitForRecording(ari, name, RECORDING_FINISHED_TIMEOUT_MS);
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
  const stasis = waitForStasisEntry(ari, snoopId, SNOOP_STASIS_TIMEOUT_MS);
  try {
    await ari.channels.snoop(channelId, {
      spy,
      whisper: 'none',
      app: 'zamfono',
      appArgs: `snoop,${channelId}`,
      snoopId
    });
  } catch (error) {
    stasis.settle('gone');
    throw error;
  }
  try {
    if ((await stasis.promise) !== 'entered') {
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
