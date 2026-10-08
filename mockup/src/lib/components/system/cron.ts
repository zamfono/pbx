/**
 * `settings.backupCron`: a five-field cron expression (minute hour day-of-month month weekday) as
 * the API's scheduler reads it, evaluated in the tenant's time zone. `parseCron` is the check
 * `settings.update` runs; `nextRuns` and `describeCron` give the human preview.
 */

type Field = { values: Set<number>; any: boolean };

export type Cron = {
  minute: Field;
  hour: Field;
  dayOfMonth: Field;
  month: Field;
  weekday: Field;
};

const RANGES: [number, number][] = [
  [0, 59],
  [0, 23],
  [1, 31],
  [1, 12],
  [0, 7]
];

const MONTH_NAMES = [
  'jan',
  'feb',
  'mar',
  'apr',
  'may',
  'jun',
  'jul',
  'aug',
  'sep',
  'oct',
  'nov',
  'dec'
];
const DAY_NAMES = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

function atom(text: string, index: number): number {
  const lower = text.toLowerCase();
  if (index === 3 && MONTH_NAMES.includes(lower)) {
    return MONTH_NAMES.indexOf(lower) + 1;
  }
  if (index === 4 && DAY_NAMES.includes(lower)) {
    return DAY_NAMES.indexOf(lower);
  }
  if (!/^\d+$/u.test(text)) {
    throw new Error(`cron: '${text}' is not a number`);
  }
  return Number(text);
}

function parseField(text: string, index: number): Field {
  const [min, max] = RANGES[index] ?? [0, 0];
  const values = new Set<number>();
  for (const part of text.split(',')) {
    const [range = '', stepText] = part.split('/');
    const step = stepText === undefined ? 1 : atom(stepText, -1);
    if (step < 1) {
      throw new Error('cron: step must be positive');
    }
    let from: number;
    let to: number;
    if (range === '*') {
      from = min;
      to = max;
    } else if (range.includes('-')) {
      const [a = '', b = ''] = range.split('-');
      from = atom(a, index);
      to = atom(b, index);
    } else {
      from = atom(range, index);
      to = stepText === undefined ? from : max;
    }
    if (from < min || to > max || from > to) {
      throw new Error(`cron: ${part} is out of range ${min}-${max}`);
    }
    for (let value = from; value <= to; value += step) {
      values.add(index === 4 && value === 7 ? 0 : value);
    }
  }
  return { values, any: text === '*' };
}

/** The parsed expression; throws when the scheduler could not run it. */
export function parseCron(expression: string): Cron {
  const fields = expression.trim().split(/\s+/u);
  if (fields.length !== 5) {
    throw new Error('cron: five fields expected');
  }
  const [minute, hour, dayOfMonth, month, weekday] = fields.map((text, index) =>
    parseField(text, index)
  ) as [Field, Field, Field, Field, Field];
  return { minute, hour, dayOfMonth, month, weekday };
}

export function isCronExpression(expression: string): boolean {
  try {
    parseCron(expression);
    return true;
  } catch {
    return false;
  }
}

type LocalParts = {
  month: number;
  day: number;
  weekday: number;
  hour: number;
  minute: number;
};

function localParts(date: Date, timeZone: string): LocalParts {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    month: 'numeric',
    day: 'numeric',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit'
  }).formatToParts(date);
  const get = (type: string): string =>
    parts.find(part => part.type === type)?.value ?? '';
  return {
    month: Number(get('month')),
    day: Number(get('day')),
    weekday: DAY_NAMES.indexOf(get('weekday').toLowerCase().slice(0, 3)),
    hour: Number(get('hour')),
    minute: Number(get('minute'))
  };
}

function dayMatches(cron: Cron, parts: LocalParts): boolean {
  if (!cron.month.values.has(parts.month)) {
    return false;
  }
  const dom = cron.dayOfMonth.values.has(parts.day);
  const dow = cron.weekday.values.has(parts.weekday);
  if (cron.dayOfMonth.any || cron.weekday.any) {
    return (cron.dayOfMonth.any || dom) && (cron.weekday.any || dow);
  }
  return dom || dow;
}

const MINUTE_MS = 60_000;
const MAX_STEPS = 200_000;

/** The next `count` times the expression fires after `from`, in `timeZone`. */
export function nextRuns(
  expression: string,
  timeZone: string,
  from: Date,
  count = 3
): Date[] {
  let cron: Cron;
  try {
    cron = parseCron(expression);
  } catch {
    return [];
  }
  const runs: Date[] = [];
  let time = Math.floor(from.getTime() / MINUTE_MS) * MINUTE_MS + MINUTE_MS;
  for (let step = 0; step < MAX_STEPS && runs.length < count; step += 1) {
    const parts = localParts(new Date(time), timeZone);
    if (!dayMatches(cron, parts)) {
      time += ((23 - parts.hour) * 60 + (60 - parts.minute)) * MINUTE_MS;
    } else if (!cron.hour.values.has(parts.hour)) {
      time += (60 - parts.minute) * MINUTE_MS;
    } else if (!cron.minute.values.has(parts.minute)) {
      time += MINUTE_MS;
    } else {
      runs.push(new Date(time));
      time += MINUTE_MS;
    }
  }
  return runs;
}

export type CronDescription =
  | { kind: 'daily'; time: string }
  | { kind: 'weekly'; time: string; weekdays: number[] }
  | { kind: 'monthly'; time: string; day: number }
  | { kind: 'everyHours'; hours: number; minute: number }
  | { kind: 'custom' };

const pad = (value: number): string => String(value).padStart(2, '0');
const single = (field: Field): number | null =>
  field.values.size === 1 ? ([...field.values][0] ?? null) : null;

/** The common shapes of a backup schedule, for a sentence; anything else is `custom`. */
export function describeCron(expression: string): CronDescription {
  let cron: Cron;
  try {
    cron = parseCron(expression);
  } catch {
    return { kind: 'custom' };
  }
  const minute = single(cron.minute);
  const hour = single(cron.hour);
  if (minute === null || !cron.month.any) {
    return { kind: 'custom' };
  }
  const hourText = expression.trim().split(/\s+/u)[1] ?? '';
  const everyHours = /^\*\/(\d+)$/u.exec(hourText);
  if (everyHours !== null && cron.dayOfMonth.any && cron.weekday.any) {
    return { kind: 'everyHours', hours: Number(everyHours[1]), minute };
  }
  if (hour === null) {
    return { kind: 'custom' };
  }
  const time = `${pad(hour)}:${pad(minute)}`;
  if (cron.dayOfMonth.any && cron.weekday.any) {
    return { kind: 'daily', time };
  }
  if (cron.dayOfMonth.any) {
    return {
      kind: 'weekly',
      time,
      weekdays: [...cron.weekday.values].sort(
        (a, b) => ((a + 6) % 7) - ((b + 6) % 7)
      )
    };
  }
  const day = single(cron.dayOfMonth);
  if (cron.weekday.any && day !== null) {
    return { kind: 'monthly', time, day };
  }
  return { kind: 'custom' };
}
