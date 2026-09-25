/**
 * `settings.backup_cron` (§11.4 "cron expression of the restic backup job", §6.5): the one parser
 * both the backup scheduler and `settings.update`'s validation read it with, so an expression the
 * API accepts is one the scheduler can run.
 */
import { CronExpressionParser } from 'cron-parser';

/** The next time `cronExpression` fires at or after `from`, evaluated in `timezone`. */
export function nextRun(
  cronExpression: string,
  timezone: string,
  from: Date
): Date {
  return CronExpressionParser.parse(cronExpression, {
    currentDate: from,
    tz: timezone
  })
    .next()
    .toDate();
}

/** Whether the scheduler can compute a next run from `cronExpression`. */
export function isCronExpression(cronExpression: string): boolean {
  try {
    nextRun(cronExpression, 'UTC', new Date());
    return true;
  } catch {
    return false;
  }
}
