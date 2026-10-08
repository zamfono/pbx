<!--
  The schedule week grid on wide screens: draw on empty space, drag a block to move it, drag its
  edges to resize it, click it to select it and click again for the exact-time popover;
  Delete/Backspace removes the focused block. With `disabled`, the same grid read-only.
-->
<script lang="ts">
  import { t } from '#lib/i18n/index.svelte.js';

  import { WeekDrag } from './drag.svelte';
  import { MINUTES_PER_HOUR, rangeGeometry, timeToMinutes } from './grid';
  import { WEEKDAYS, type Week, type Weekday } from './hours';
  import { weekdayName } from './labels';
  import RangePopover from './RangePopover.svelte';
  import { WeekSelection } from './selection.svelte';

  type Props = {
    idPrefix: string;
    week: Week;
    onChange: (week: Week) => void;
    disabled?: boolean;
  };

  let { idPrefix, week, onChange, disabled = false }: Props = $props();

  const PX_PER_HOUR = 40;
  const PERCENT = 100;
  /** Blocks shorter than this hide the grip bars: the label and two grips would collide. */
  const GRIP_MIN_MINUTES = 45;

  const dragging = new WeekDrag(
    () => week,
    (next, kind) => {
      // A drawn range is inserted sorted, which may shift the indices the selection points at.
      if (kind === 'draw') {
        selection.clear();
      }
      onChange(next);
    }
  );

  const selection = new WeekSelection(
    dragging,
    () => week,
    next => {
      onChange(next);
    }
  );

  let container = $state<HTMLDivElement>();

  const bounds = $derived(dragging.bounds);
  const axisSpan = $derived(dragging.axisSpan);
  const axisHeight = $derived(
    `${(axisSpan / MINUTES_PER_HOUR) * PX_PER_HOUR}px`
  );
  const axisMarks = $derived.by(() => {
    const marks: number[] = [];
    for (
      let minute = bounds.start;
      minute <= bounds.end;
      minute += MINUTES_PER_HOUR
    ) {
      marks.push(minute);
    }
    return marks;
  });

  const axisPercent = (minute: number): number =>
    ((minute - bounds.start) / axisSpan) * PERCENT;

  const hourLabel = (minute: number): string =>
    `${String(Math.floor(minute / MINUTES_PER_HOUR)).padStart(2, '0')}:00`;

  const durationOf = (start: string, end: string): number =>
    (timeToMinutes(end) ?? 0) - (timeToMinutes(start) ?? 0);

  const blockStyle = (geometry: {
    topPercent: number;
    heightPercent: number;
  }): string =>
    `top: ${geometry.topPercent}%; height: ${geometry.heightPercent}%`;

  const blockId = (weekday: Weekday, index: number): string =>
    `${idPrefix}-grid-${weekday}-${index}`;
</script>

<svelte:window
  onpointermove={dragging.move}
  onpointerup={dragging.end}
  onpointercancel={dragging.cancel}
/>

<div class="grid-view" class:disabled bind:this={container}>
  <div class="week">
    <div></div>
    {#each WEEKDAYS as weekday (weekday)}
      <div class="head" title={weekdayName(weekday)}>
        {weekdayName(weekday, 'short')}
      </div>
    {/each}

    <div class="axis" style:height={axisHeight} aria-hidden="true">
      {#each axisMarks as minute (minute)}
        <span class="axis-label" style:top={`${axisPercent(minute)}%`}>
          {hourLabel(minute)}
        </span>
      {/each}
    </div>

    {#each WEEKDAYS as weekday (weekday)}
      {@const day = weekdayName(weekday)}
      <!-- Drawing by pointer is an enhancement; the popover and the narrow-screen list carry the keyboard path to exact times. -->
      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <div
        data-day-column
        class="column"
        style:height={axisHeight}
        onpointerdown={disabled
          ? undefined
          : event => {
              dragging.beginDraw(event, weekday);
            }}
      >
        {#each axisMarks.slice(1, -1) as minute (minute)}
          <div class="hour-line" style:top={`${axisPercent(minute)}%`}></div>
        {/each}

        {#each week[weekday] as range, index (index)}
          {@const shown = dragging.shownRange(weekday, index, range)}
          {@const geometry = rangeGeometry(shown, bounds)}
          {#if disabled}
            <div
              class="block"
              style={blockStyle(geometry)}
              aria-label={t('schedule.grid.blockReadonly', {
                day,
                start: shown.start,
                end: shown.end
              })}
              role="img"
            >
              <span class="block-label">{shown.start}–{shown.end}</span>
            </div>
          {:else}
            {@const showGrips =
              durationOf(shown.start, shown.end) >= GRIP_MIN_MINUTES}
            <button
              id={blockId(weekday, index)}
              type="button"
              class="block interactive"
              class:selected={selection.isSelected(weekday, index)}
              class:with-grips={showGrips}
              style={blockStyle(geometry)}
              aria-label={t('schedule.grid.block', {
                day,
                start: shown.start,
                end: shown.end
              })}
              aria-pressed={selection.isSelected(weekday, index)}
              aria-haspopup="dialog"
              onpointerdown={event => {
                dragging.beginBlockDrag(event, weekday, index, 'move');
              }}
              onclick={event => {
                selection.onBlockClick(event, weekday, index);
              }}
              onkeydown={event => {
                if (event.key === 'Delete' || event.key === 'Backspace') {
                  event.preventDefault();
                  selection.deleteBlock(weekday, index);
                }
              }}
            >
              <span class="block-label">{shown.start}–{shown.end}</span>
              <!-- Resizing by pointer is an enhancement; the popover is the keyboard path to exact times. -->
              <span
                class="grip top"
                aria-hidden="true"
                onpointerdown={event => {
                  dragging.beginBlockDrag(
                    event,
                    weekday,
                    index,
                    'resize-start'
                  );
                }}
              >
                {#if showGrips}<span class="grip-bar"></span>{/if}
              </span>
              <span
                class="grip bottom"
                aria-hidden="true"
                onpointerdown={event => {
                  dragging.beginBlockDrag(event, weekday, index, 'resize-end');
                }}
              >
                {#if showGrips}<span class="grip-bar"></span>{/if}
              </span>
            </button>
          {/if}
        {/each}

        {#if dragging.drag?.kind === 'draw' && dragging.drag.weekday === weekday && dragging.drag.preview !== undefined}
          {@const preview = dragging.drag.preview}
          <div
            class="block draft"
            style={blockStyle(rangeGeometry(preview, bounds))}
          >
            <span class="block-label">{preview.start}–{preview.end}</span>
          </div>
        {/if}
      </div>
    {/each}
  </div>

  {#if !disabled}
    <p class="hint">{t('schedule.grid.hint')}</p>
  {/if}

  {#if !disabled && selection.editing !== undefined && selection.editingRange !== undefined}
    <RangePopover
      id={`${idPrefix}-popover-${selection.editing.weekday}-${selection.editing.index}`}
      day={weekdayName(selection.editing.weekday)}
      anchor={selection.editingAnchor}
      {container}
      range={selection.editingRange}
      onClose={selection.closeEditor}
      onDelete={selection.deleteEditing}
      onEdit={selection.updateEditing}
    />
  {/if}
</div>

<style>
  .grid-view {
    position: relative;
    user-select: none;
  }

  @media (max-width: 767.98px) {
    .grid-view {
      display: none;
    }
  }

  .week {
    display: grid;
    grid-template-columns: 3rem repeat(7, minmax(0, 1fr));
  }

  .head {
    overflow: hidden;
    padding-bottom: var(--space-1);
    color: var(--text-muted);
    font-size: var(--text-sm);
    font-weight: 700;
    text-align: center;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .axis {
    position: relative;
  }

  .axis-label {
    position: absolute;
    right: 6px;
    transform: translateY(-50%);
    color: var(--text-faint);
    font-family: var(--font-mono);
    font-size: 10px;
    line-height: 1;
  }

  .column {
    position: relative;
    border-top: 1px solid var(--line);
    border-bottom: 1px solid var(--line);
    border-left: 1px solid var(--line);
    background: var(--surface);
    cursor: crosshair;
    touch-action: none;
  }

  .column:last-child {
    border-right: 1px solid var(--line);
  }

  .disabled .column {
    background: var(--surface-2);
    cursor: default;
  }

  .hour-line {
    position: absolute;
    inset-inline: 0;
    border-top: 1px dashed var(--line);
    pointer-events: none;
  }

  .block {
    position: absolute;
    inset-inline: 2px;
    display: flex;
    flex-direction: column;
    justify-content: flex-start;
    overflow: hidden;
    margin: 0;
    padding: 2px var(--space-1) 0;
    border: 1px solid color-mix(in srgb, var(--primary) 45%, transparent);
    border-radius: var(--radius-xs);
    background: color-mix(in srgb, var(--primary) 16%, var(--surface));
    color: var(--text);
    font-size: 11px;
    line-height: 1.2;
    text-align: left;
  }

  .block-label {
    display: block;
    overflow: hidden;
    font-family: var(--font-mono);
    font-variant-numeric: tabular-nums;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .interactive {
    cursor: grab;
  }

  .interactive:active {
    cursor: grabbing;
  }

  .interactive:hover {
    background: color-mix(in srgb, var(--primary) 26%, var(--surface));
  }

  .interactive.with-grips {
    padding-top: var(--space-2);
  }

  .interactive.selected {
    border-color: var(--primary);
    box-shadow: 0 0 0 2px var(--primary);
  }

  .interactive:focus-visible {
    outline: 2px solid var(--focus);
    outline-offset: 2px;
  }

  .draft {
    border-style: dashed;
    background: color-mix(in srgb, var(--primary) 10%, transparent);
    pointer-events: none;
  }

  .grip {
    position: absolute;
    inset-inline: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    height: 8px;
    cursor: ns-resize;
  }

  .grip.top {
    top: 0;
  }

  .grip.bottom {
    bottom: 0;
  }

  .grip-bar {
    width: 20px;
    height: 4px;
    border-block: 1px solid color-mix(in srgb, var(--primary) 65%, transparent);
  }

  .hint {
    margin-top: var(--space-2);
    color: var(--text-muted);
    font-size: var(--text-xs);
  }
</style>
