/**
 * The ffmpeg side of one recorded participation (§10.2 "Call recording"): the stereo mix of its
 * raw per-leg pair. Its own module so `recordingChannels.ts`, the Asterisk side, stays one
 * responsibility.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** Mixes a raw pair into `outPath` and resolves with the mixed file's own length in seconds, the
 * `recordings.duration_s` it stores (§11.2). */
export type Mixer = (
  leftPath: string,
  rightPath: string,
  outPath: string
) => Promise<number>;

// `amerge` alone stops at the shorter of its two inputs (§10.2 "A `recordings` row asserts that a
// playable file exists"): a muted phone, Opus DTX or a one-way leg then truncates the mix to
// whichever side spoke less. Each input is `apad`ded — silence appended for as long as ffmpeg is
// asked to keep going — and the output is cut to the longer input's own duration, so the shorter
// channel is silence-padded rather than the file being cut short.
const MIX_FILTER =
  '[0:a]apad[left];[1:a]apad[right];[left][right]amerge=inputs=2[out]';

/** The duration ffprobe reports for `filePath`, in seconds, or 0 for a file with no audio samples
 * at all (a header-only recording, §10.2 "Best effort": a snoop that captured nothing). */
async function probeDurationS(filePath: string): Promise<number> {
  const { stdout } = await execFileAsync('ffprobe', [
    '-v',
    'error',
    '-show_entries',
    'format=duration',
    '-of',
    'default=noprint_wrappers=1:nokey=1',
    filePath
  ]);
  const durationS = Number.parseFloat(stdout.trim());
  return Number.isFinite(durationS) ? durationS : 0;
}

/** The default mixer (§10.2 "Channels and stereo mapping"): left the recorded user's own voice,
 * right what they heard, spanning whichever raw input is longer, its counterpart padded with
 * silence. The output keeps the pair's own sample rate, 8 or 16 kHz (§10.2 "Sample rate"): no
 * `-ar` resamples it, and both halves of a pair are recorded in the same format. Both inputs empty (no audio samples on either side) is a mix failure, not a header-only
 * output: `storeParticipation` must never insert a `recordings` row for it. Resolves with the
 * mix's length, the longer input's, measured from the audio itself: Asterisk's `RecordingFinished`
 * duration divides the samples by 8000 whatever the format, doubling a `wav16` recording's. */
export async function ffmpegMix(
  leftPath: string,
  rightPath: string,
  outPath: string
): Promise<number> {
  const [leftDurationS, rightDurationS] = await Promise.all([
    probeDurationS(leftPath),
    probeDurationS(rightPath)
  ]);
  const durationS = Math.max(leftDurationS, rightDurationS);
  if (durationS <= 0) {
    throw new Error('recording mix: both raw channels are empty');
  }
  await execFileAsync('ffmpeg', [
    '-y',
    '-i',
    leftPath,
    '-i',
    rightPath,
    '-filter_complex',
    MIX_FILTER,
    '-map',
    '[out]',
    '-t',
    String(durationS),
    '-ac',
    '2',
    outPath
  ]);
  return durationS;
}
