/**
 * A backup schedule in words ("Daily at 03:00"), and its next runs, in the UI language.
 */
import { nowDate as demoNowDate } from '#lib/clock.svelte.js';
import { formatDateTime, t } from '#lib/i18n/index.svelte.js';

import { describeCron, nextRuns } from './cron';

const WEEKDAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

export function cronSentence(expression: string): string {
  const description = describeCron(expression);
  switch (description.kind) {
    case 'daily':
      return t('system.cron.daily', { time: description.time });
    case 'weekly':
      return t('system.cron.weekly', {
        days: description.weekdays
          .map(day => t(`system.weekday.${WEEKDAY_KEYS[day] ?? 'mon'}`))
          .join(', '),
        time: description.time
      });
    case 'monthly':
      return t('system.cron.monthly', {
        day: description.day,
        time: description.time
      });
    case 'everyHours':
      return t('system.cron.everyHours', {
        hours: description.hours,
        minute: String(description.minute).padStart(2, '0')
      });
    default:
      return t('system.cron.custom');
  }
}

/** The next runs, formatted; empty for an invalid expression. */
export function cronNextRuns(
  expression: string,
  timezone: string | null,
  count = 3
): string[] {
  return nextRuns(
    expression,
    timezone ?? 'Europe/Berlin',
    demoNowDate(),
    count
  ).map(date => formatDateTime(date.toISOString()));
}
