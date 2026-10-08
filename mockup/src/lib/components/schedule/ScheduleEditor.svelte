<!--
  The weekly opening-hours editor: the week grid on wide screens, the per-day list on narrow
  ones, and below them the first rule the week breaks. It emits every edit as the API's
  `HoursInterval[]`, unmerged; the caller saves `mergeTouching(intervals)` once
  `validateIntervals` passes. With `disabled`, a read-only rendering.
-->
<script lang="ts">
  import type { HoursInterval } from '#lib/api/types.js';
  import { t } from '#lib/i18n/index.svelte.js';

  import {
    intervalsFromWeek,
    isWeekday,
    validateIntervals,
    weekFromIntervals,
    type Week
  } from './hours';
  import { weekdayName } from './labels';
  import WeekGrid from './WeekGrid.svelte';
  import WeekList from './WeekList.svelte';

  type Props = {
    idPrefix: string;
    intervals: HoursInterval[];
    onChange: (intervals: HoursInterval[]) => void;
    disabled?: boolean;
  };

  let { idPrefix, intervals, onChange, disabled = false }: Props = $props();

  const week = $derived(weekFromIntervals(intervals));
  const error = $derived(validateIntervals(intervals));
  const errorMessage = $derived(
    error === undefined
      ? undefined
      : t(error.code, {
          day: isWeekday(error.weekday)
            ? weekdayName(error.weekday)
            : error.weekday
        })
  );

  const emit = (next: Week) => {
    onChange(intervalsFromWeek(next));
  };
</script>

<div class="schedule-editor">
  <WeekGrid {idPrefix} {week} onChange={emit} {disabled} />
  <WeekList {idPrefix} {week} onChange={emit} {disabled} />

  {#if errorMessage !== undefined}
    <p class="error" id={`${idPrefix}-error`} role="alert">{errorMessage}</p>
  {/if}
</div>

<style>
  .schedule-editor {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
  }

  .error {
    color: var(--danger);
    font-size: var(--text-sm);
    font-weight: 500;
  }
</style>
