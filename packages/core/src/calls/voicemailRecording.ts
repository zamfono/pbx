/**
 * The voicemail deposit's recording (§10.2 "Voicemail"): `POST /channels/{id}/record` on the
 * caller and the wait for Asterisk's outcome of it, its own module beside `voicemail.ts`, which
 * owns the deposit's flow, so both stay under the repository's `max-lines` lint rule.
 */
import { MS_PER_SECOND } from '@zamfono/shared';

import type { AriClient } from '../ari/client.js';
import { isGone } from '../ari/failures.js';
import type { AriEvent, RecordParams } from '../ari/types.js';

// §10.2 "Voicemail": the silence stop is a fixed constant, not a per-tenant setting, since it has
// to outlast a caller's pause for thought and stay short enough not to record dead air.
const VOICEMAIL_SILENCE_SECONDS = 5;
// The `RecordingFinished`/`RecordingFailed` fallback's margin past `maxDurationSeconds`.
const RECORDING_FALLBACK_BUFFER_S = 5;

export type RecordingOutcome =
  | { kind: 'finished'; durationS: number }
  | { kind: 'failed' }
  | { kind: 'destroyed' };

// How long a caller channel's destruction waits for the recording's own outcome. Hanging up is
// how a caller ends a message, and Asterisk stops and finalises the recording as the channel
// goes, so `RecordingFinished` follows `ChannelDestroyed` rather than preceding it; resolving on
// the channel alone would discard every message left the ordinary way.
const RECORDING_AFTER_HANGUP_MS = 2000;

/**
 * Starts the recording `options.name` and waits for it to end (§10.2): `RecordingFinished`
 * resolves with its reported duration, `RecordingFailed` with none, for `deposit` to treat as no
 * message recorded. The caller channel going away shortens the wait to
 * `RECORDING_AFTER_HANGUP_MS` instead of ending it, since that is the ordinary end of a message
 * and the recording is finalised just after. A refused record request ends the wait at once, as
 * `destroyed` for a channel that is already gone (a caller who hung up during the greeting, whose
 * `ChannelDestroyed` preceded this listener), since no recording follows either way. `timeoutMs`
 * is the safety net for events that never arrive, so the listener is always eventually removed.
 */
function recordAndWait(
  ari: AriClient,
  channelId: string,
  options: RecordParams,
  timeoutMs: number
): Promise<RecordingOutcome> {
  const { name } = options;
  return new Promise(resolve => {
    // Rearmed when the caller's channel goes, so the two waits share one handle; held in an
    // object because ESLint's `init-declarations` leaves no way to declare it unassigned.
    const pending: { timer: ReturnType<typeof setTimeout> | null } = {
      timer: null
    };
    const finish = (outcome: RecordingOutcome): void => {
      // eslint-disable-next-line no-use-before-define -- finish and onEvent reference each other
      ari.off('event', onEvent);
      if (pending.timer !== null) {
        clearTimeout(pending.timer);
      }
      resolve(outcome);
    };
    function onEvent(ev: AriEvent): void {
      const channel = ev.channel as { id?: string } | undefined;
      if (
        (ev.type === 'ChannelDestroyed' || ev.type === 'StasisEnd') &&
        channel?.id === channelId
      ) {
        if (pending.timer !== null) {
          clearTimeout(pending.timer);
        }
        pending.timer = setTimeout(() => {
          finish({ kind: 'destroyed' });
        }, RECORDING_AFTER_HANGUP_MS);
        pending.timer.unref();
        return;
      }
      const recording = ev.recording as
        { name?: string; duration?: number } | undefined;
      if (recording?.name !== name) {
        return;
      }
      if (ev.type === 'RecordingFinished') {
        finish({ kind: 'finished', durationS: recording.duration ?? 0 });
      } else if (ev.type === 'RecordingFailed') {
        finish({ kind: 'failed' });
      }
    }
    ari.on('event', onEvent);
    pending.timer = setTimeout(() => {
      finish({ kind: 'failed' });
    }, timeoutMs);
    pending.timer.unref();
    // Requested once the listener is up, so no outcome of the recording can fire unseen.
    ari.channels.record(channelId, options).catch((error: unknown) => {
      finish({ kind: isGone(error) ? 'destroyed' : 'failed' });
    });
  });
}

/** Records the caller as `name` (§10.2 "Voicemail": capped at `settings.voicemail_max_s`, a 5 s
 * silence stop, `#` to end) and waits for the recording's outcome. */
export async function recordCaller(
  ari: AriClient,
  channelId: string,
  name: string,
  maxDurationSeconds: number
): Promise<RecordingOutcome> {
  const timeoutMs =
    (maxDurationSeconds + RECORDING_FALLBACK_BUFFER_S) * MS_PER_SECOND;
  return recordAndWait(
    ari,
    channelId,
    {
      name,
      format: 'wav',
      maxDurationSeconds,
      maxSilenceSeconds: VOICEMAIL_SILENCE_SECONDS,
      terminateOn: '#'
    },
    timeoutMs
  );
}
