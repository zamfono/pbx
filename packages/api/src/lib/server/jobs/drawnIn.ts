/**
 * The schedule of the jobs that wait for the maintenance gate (`maintenanceWindow.ts`), the
 * certificate sync (§6.4) and the automatic update (§6.3 "Automatic updates"): a pass at once,
 * then hourly, drawn in to the moment a pass names whenever that falls sooner.
 */
import { MINUTES_PER_HOUR, MS_PER_SECOND } from '@zamfono/shared';

const SECONDS_PER_MINUTE = 60;
/** The coarsest poll; the jobs' own timing is day-scale, and the poll is drawn in to it. */
export const POLL_INTERVAL_MS =
  MINUTES_PER_HOUR * SECONDS_PER_MINUTE * MS_PER_SECOND;

export type DrawnInJob = {
  /** One pass; resolves to when the next is due, or `null` for the regular poll. */
  pass: () => Promise<Date | null>;
  /** Reports a pass that rejected; the next poll retries. */
  failed: (error: unknown) => void;
  now?: () => Date;
};

export type DrawnInSchedule = {
  /** Runs a pass at once instead of at the pending timer, which it resets. */
  runNow: () => void;
  /** Cancels the next pass; one already in flight finishes. */
  stop: () => void;
};

/**
 * Runs `job.pass` now and then on the drawn-in poll until stopped, one pass at a time: a pass
 * asked for while one is in flight runs once that one has settled.
 */
export function scheduleDrawnIn(job: DrawnInJob): DrawnInSchedule {
  const now = job.now ?? (() => new Date());
  let timer: NodeJS.Timeout | undefined;
  let stopped = false;
  let inFlight = false;
  let again = false;
  const tick = (): void => {
    clearTimeout(timer);
    if (inFlight) {
      again = true;
      return;
    }
    inFlight = true;
    const settle = (next: Date | null): void => {
      inFlight = false;
      if (stopped) {
        return;
      }
      if (again) {
        again = false;
        tick();
        return;
      }
      const untilDueMs =
        next === null ? POLL_INTERVAL_MS : next.getTime() - now().getTime();
      timer = setTimeout(
        tick,
        Math.min(POLL_INTERVAL_MS, Math.max(0, untilDueMs))
      );
    };
    job.pass().then(settle, (error: unknown) => {
      job.failed(error);
      settle(null);
    });
  };
  tick();
  return {
    runNow: () => {
      if (!stopped) {
        tick();
      }
    },
    stop: () => {
      stopped = true;
      clearTimeout(timer);
    }
  };
}
