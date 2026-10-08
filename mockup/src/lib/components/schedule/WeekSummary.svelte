<!--
  A one-line read-only summary of opening hours: consecutive days with the same hours share one
  entry, e.g. "Mo–Do 08:00–12:30, 13:30–17:30 · Fr 08:00–14:00". Closed days are left out.
-->
<script lang="ts">
  import type { HoursInterval } from '#lib/api/types.js';
  import { t } from '#lib/i18n/index.svelte.js';

  import { groupWeek, type DayGroup } from './hours';
  import { weekdayName } from './labels';

  type Props = { intervals: HoursInterval[] };

  let { intervals }: Props = $props();

  const groups = $derived(groupWeek(intervals));

  const days = (group: DayGroup): string =>
    group.from === group.to
      ? weekdayName(group.from, 'short')
      : `${weekdayName(group.from, 'short')}–${weekdayName(group.to, 'short')}`;

  const daysTitle = (group: DayGroup): string =>
    group.from === group.to
      ? weekdayName(group.from)
      : `${weekdayName(group.from)}–${weekdayName(group.to)}`;
</script>

<span class="summary" aria-label={t('schedule.summary.label')} role="group">
  {#if groups.length === 0}
    <span class="closed">{t('schedule.summary.closed')}</span>
  {:else}
    {#each groups as group, position (group.from)}
      {#if position > 0}
        <span class="separator" aria-hidden="true">·</span>
      {/if}
      <span class="entry">
        <abbr class="days" title={daysTitle(group)}>{days(group)}</abbr>
        <span class="times">
          {group.ranges.map(range => `${range.start}–${range.end}`).join(', ')}
        </span>
      </span>
    {/each}
  {/if}
</span>

<style>
  .summary {
    color: var(--text);
    font-size: var(--text-sm);
  }

  .entry {
    white-space: nowrap;
  }

  .days {
    font-weight: 700;
    text-decoration: none;
  }

  .times {
    font-variant-numeric: tabular-nums;
  }

  .separator {
    margin-inline: 0.3em;
  }

  .separator,
  .closed {
    color: var(--text-muted);
  }
</style>
