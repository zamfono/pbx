<!--
  The exact-time fields of one opening range: start, end, and "until 24:00". A time input cannot
  hold 24:00, so a `24:00` end shows as 00:00 with the checkbox ticked, and an end typed as 00:00
  means midnight at the end of the day.
-->
<script lang="ts">
  import { t } from '#lib/i18n/index.svelte.js';

  import { END_OF_DAY, type DayRange } from './hours';

  type Props = {
    id: string;
    day: string;
    range: DayRange;
    onEdit: (edge: keyof DayRange, value: string) => void;
  };

  let { id, day, range, onEdit }: Props = $props();

  /** The end a checkbox untick restores: the last quarter hour of the day. */
  const LAST_QUARTER = '23:45';
  const MIDNIGHT = '00:00';

  const untilMidnight = $derived(range.end === END_OF_DAY);
</script>

<div class="fields">
  <input
    id={`${id}-start`}
    class="time"
    type="time"
    step="900"
    aria-label={t('schedule.range.dayStart', { day })}
    value={range.start}
    oninput={event => {
      onEdit('start', event.currentTarget.value);
    }}
  />
  <span class="dash" aria-hidden="true">–</span>
  <input
    id={`${id}-end`}
    class="time"
    type="time"
    step="900"
    aria-label={t('schedule.range.dayEnd', { day })}
    value={untilMidnight ? MIDNIGHT : range.end}
    oninput={event => {
      const value = event.currentTarget.value;
      onEdit('end', value === MIDNIGHT ? END_OF_DAY : value);
    }}
  />
  <label class="midnight" title={t('schedule.range.untilMidnightLabel')}>
    <input
      id={`${id}-midnight`}
      type="checkbox"
      checked={untilMidnight}
      onchange={event => {
        onEdit('end', event.currentTarget.checked ? END_OF_DAY : LAST_QUARTER);
      }}
    />
    <span>{t('schedule.range.untilMidnight')}</span>
  </label>
</div>

<style>
  .fields {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--space-2);
  }

  .time {
    min-width: 0;
    width: 7.5rem;
    padding: 6px var(--space-2);
    border: 1px solid var(--line-strong);
    border-radius: var(--radius-xs);
    background: var(--surface);
    font-family: var(--font-mono);
    font-size: var(--text-sm);
  }

  .time:focus-visible {
    outline: 2px solid var(--focus);
    outline-offset: 1px;
  }

  .dash {
    color: var(--text-muted);
  }

  .midnight {
    display: inline-flex;
    align-items: center;
    gap: var(--space-1);
    color: var(--text-muted);
    font-size: var(--text-sm);
    white-space: nowrap;
    cursor: pointer;
  }

  .midnight input {
    accent-color: var(--primary);
    margin: 0;
  }
</style>
