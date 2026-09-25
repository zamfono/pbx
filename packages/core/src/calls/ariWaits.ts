/** Waiting on ARI's event stream for a recording's end, with a timeout: the wait subscribes,
 * resolves once and unsubscribes; `mailboxGreeting.ts` uses it (§10.2 "Mailbox access"), and its
 * coverage lives in `mailbox.test.ts` and `features.test.ts`. The mailbox menu's key input is
 * `mailboxInput.ts`'s. */
import type { AriClient } from '../ari/client.js';
import type { AriEvent } from '../ari/types.js';

/** Waits for the recording named `name` to end, its reported duration or `null` on failure. */
export function waitForRecording(
  ari: AriClient,
  name: string,
  timeoutMs: number
): Promise<number | null> {
  return new Promise(resolve => {
    const finish = (durationS: number | null): void => {
      // eslint-disable-next-line no-use-before-define -- finish, onEvent and timer reference each other; each is declared below
      ari.off('event', onEvent);
      // eslint-disable-next-line no-use-before-define -- see above
      clearTimeout(timer);
      resolve(durationS);
    };
    function onEvent(ev: AriEvent): void {
      const recording = ev.recording as
        { name?: string; duration?: number } | undefined;
      if (recording?.name !== name) {
        return;
      }
      if (ev.type === 'RecordingFinished') {
        finish(recording.duration ?? 0);
        return;
      }
      if (ev.type === 'RecordingFailed') {
        finish(null);
      }
    }
    ari.on('event', onEvent);
    const timer = setTimeout(() => {
      finish(null);
    }, timeoutMs);
    timer.unref();
  });
}
