<!--
  The schedule editor on narrow screens: each day with its ranges as rows of time inputs, a
  remove button per range and an add button per day. With `disabled`, the ranges as text.
-->
<script lang="ts">
  import Plus from '@lucide/svelte/icons/plus';
  import Trash2 from '@lucide/svelte/icons/trash-2';

  import { t } from '#lib/i18n/index.svelte.js';

  import {
    addRange,
    removeRange,
    setRange,
    WEEKDAYS,
    type Week
  } from './hours';
  import { weekdayName } from './labels';
  import RangeFields from './RangeFields.svelte';

  type Props = {
    idPrefix: string;
    week: Week;
    onChange: (week: Week) => void;
    disabled?: boolean;
  };

  let { idPrefix, week, onChange, disabled = false }: Props = $props();
</script>

<div class="list-view">
  {#each WEEKDAYS as weekday (weekday)}
    {@const day = weekdayName(weekday)}
    {@const ranges = week[weekday]}
    <section class="day" aria-labelledby={`${idPrefix}-list-${weekday}`}>
      <h4 class="day-name" id={`${idPrefix}-list-${weekday}`}>{day}</h4>

      {#if disabled}
        <p class="readonly">
          {#if ranges.length === 0}
            <span class="closed">{t('schedule.day.closed')}</span>
          {:else}
            {ranges.map(range => `${range.start}–${range.end}`).join(', ')}
          {/if}
        </p>
      {:else}
        {#if ranges.length === 0}
          <p class="closed">{t('schedule.day.closed')}</p>
        {/if}
        <ul class="ranges">
          {#each ranges as range, index (index)}
            <li class="range">
              <RangeFields
                id={`${idPrefix}-list-${weekday}-${index}`}
                {day}
                {range}
                onEdit={(edge, value) => {
                  onChange(setRange(week, weekday, index, { [edge]: value }));
                }}
              />
              <button
                type="button"
                class="icon danger"
                aria-label={t('schedule.range.dayRemove', {
                  day,
                  start: range.start,
                  end: range.end
                })}
                title={t('schedule.range.remove')}
                onclick={() => {
                  onChange(removeRange(week, weekday, index));
                }}
              >
                <Trash2 size={16} />
              </button>
            </li>
          {/each}
        </ul>
        <button
          type="button"
          class="add"
          aria-label={t('schedule.range.dayAdd', { day })}
          onclick={() => {
            onChange(addRange(week, weekday));
          }}
        >
          <Plus size={14} />
          {t('schedule.range.add')}
        </button>
      {/if}
    </section>
  {/each}
</div>

<style>
  .list-view {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
  }

  @media (min-width: 768px) {
    .list-view {
      display: none;
    }
  }

  .day {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    padding-bottom: var(--space-3);
    border-bottom: 1px solid var(--line);
  }

  .day:last-child {
    border-bottom: none;
  }

  .day-name {
    font-family: var(--font-body);
    font-size: var(--text-md);
    font-weight: 700;
    letter-spacing: 0;
  }

  .ranges {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    margin: 0;
    padding: 0 0 0 var(--space-3);
    list-style: none;
  }

  .ranges:empty {
    display: none;
  }

  .range {
    display: flex;
    align-items: center;
    gap: var(--space-2);
  }

  .readonly {
    font-family: var(--font-mono);
    font-size: var(--text-sm);
  }

  .closed {
    color: var(--text-muted);
    font-family: var(--font-body);
    font-size: var(--text-sm);
  }

  .icon {
    display: inline-grid;
    flex: none;
    place-items: center;
    width: 32px;
    height: 32px;
    padding: 0;
    border: 1px solid var(--line);
    border-radius: var(--radius-xs);
    background: var(--surface-2);
    cursor: pointer;
  }

  .icon.danger {
    color: var(--danger);
  }

  .icon.danger:hover {
    background: var(--danger-soft);
  }

  .add {
    display: inline-flex;
    align-items: center;
    align-self: flex-start;
    gap: var(--space-1);
    margin-left: var(--space-3);
    padding: 4px var(--space-3);
    border: 1px dashed var(--line-strong);
    border-radius: var(--radius-pill);
    background: transparent;
    color: var(--primary);
    font-size: var(--text-sm);
    font-weight: 600;
    cursor: pointer;
  }

  .add:hover {
    background: var(--primary-soft);
  }

  .icon:focus-visible,
  .add:focus-visible {
    outline: 2px solid var(--focus);
    outline-offset: 1px;
  }
</style>
