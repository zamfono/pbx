<!--
  The out-of-office rules on a horizontal timeline from today to about 90 days ahead (further when
  a rule reaches beyond): month ticks, a marker for now, one bar per rule. A rule without start
  applies from now; one without expiry runs to the edge and fades out; inactive rules are hatched
  and dimmed. Deleted and expired rules are not shown. On narrow screens, a list of date ranges.
-->
<script lang="ts">
  import type { OooRule } from '#lib/api/types.js';
  import { now as demoNow } from '#lib/clock.svelte.js';
  import { formatDate, t } from '#lib/i18n/index.svelte.js';

  import { monthLabel } from './labels';
  import {
    monthTicks,
    percentOf,
    ruleBar,
    timelineWindow,
    visibleRules
  } from './ooo';

  type Props = {
    rules: OooRule[];
    onSelect?: (rule: OooRule) => void;
    now?: string;
  };

  let { rules, onSelect, now }: Props = $props();

  const START_LABEL_ROOM_PERCENT = 8;
  const LAST_LABEL_PERCENT = 95;

  const nowTime = $derived(now === undefined ? demoNow() : Date.parse(now));
  const view = $derived(timelineWindow(rules, nowTime));
  const ticks = $derived(monthTicks(view));
  /** Month names on the ticks, without the one on the right edge; the start's month too when no tick crowds it. */
  const labels = $derived([
    ...((ticks[0]?.percent ?? 100) > START_LABEL_ROOM_PERCENT
      ? [{ time: view.start, percent: 0 }]
      : []),
    ...ticks.filter(tick => tick.percent < LAST_LABEL_PERCENT)
  ]);
  const bars = $derived(
    visibleRules(rules, nowTime).map(rule => ruleBar(rule, view, nowTime))
  );
  const nowPercent = $derived(percentOf(nowTime, view));

  const rangeLabel = (rule: OooRule): string =>
    t('schedule.ooo.range', {
      from:
        rule.startsAt === null
          ? t('schedule.ooo.fromNow')
          : formatDate(rule.startsAt),
      to:
        rule.expiresAt === null
          ? t('schedule.ooo.openEnded')
          : formatDate(rule.expiresAt)
    });

  const fullLabel = (rule: OooRule): string =>
    rule.active
      ? rangeLabel(rule)
      : `${rangeLabel(rule)} (${t('schedule.ooo.inactive')})`;
</script>

<div class="ooo" role="group" aria-label={t('schedule.ooo.label')}>
  {#if bars.length === 0}
    <p class="empty">{t('schedule.ooo.empty')}</p>
  {:else}
    <div class="timeline">
      <div class="ticks" aria-hidden="true">
        {#each labels as tick (tick.time)}
          <span class="tick-label" style:left={`${tick.percent}%`}>
            {monthLabel(tick.time)}
          </span>
        {/each}
      </div>

      <div class="lanes">
        {#each ticks as tick (tick.time)}
          <div class="gridline" style:left={`${tick.percent}%`}></div>
        {/each}

        <div class="now" style:left={`${nowPercent}%`} aria-hidden="true">
          <span class="now-label">{t('schedule.ooo.now')}</span>
        </div>

        {#each bars as bar (bar.rule.id)}
          <div class="lane">
            {#if onSelect === undefined}
              <div
                class="bar"
                class:inactive={!bar.rule.active}
                class:open-end={bar.openEnd}
                class:clipped-start={bar.clippedStart}
                style:left={`${bar.leftPercent}%`}
                style:width={`${bar.widthPercent}%`}
                title={fullLabel(bar.rule)}
              >
                <span class="bar-label">{fullLabel(bar.rule)}</span>
              </div>
            {:else}
              <button
                type="button"
                class="bar"
                class:inactive={!bar.rule.active}
                class:open-end={bar.openEnd}
                class:clipped-start={bar.clippedStart}
                style:left={`${bar.leftPercent}%`}
                style:width={`${bar.widthPercent}%`}
                title={fullLabel(bar.rule)}
                aria-label={t('schedule.ooo.select', {
                  range: fullLabel(bar.rule)
                })}
                onclick={() => {
                  onSelect(bar.rule);
                }}
              >
                <span class="bar-label">{fullLabel(bar.rule)}</span>
              </button>
            {/if}
          </div>
        {/each}
      </div>
    </div>

    <ul class="list">
      {#each bars as bar (bar.rule.id)}
        <li>
          {#if onSelect === undefined}
            <div class="item" class:inactive={!bar.rule.active}>
              <span class="item-range">{rangeLabel(bar.rule)}</span>
              <span class="badge" class:off={!bar.rule.active}>
                {bar.rule.active
                  ? t('schedule.ooo.active')
                  : t('schedule.ooo.inactive')}
              </span>
            </div>
          {:else}
            <button
              type="button"
              class="item"
              class:inactive={!bar.rule.active}
              aria-label={t('schedule.ooo.select', {
                range: fullLabel(bar.rule)
              })}
              onclick={() => {
                onSelect(bar.rule);
              }}
            >
              <span class="item-range">{rangeLabel(bar.rule)}</span>
              <span class="badge" class:off={!bar.rule.active}>
                {bar.rule.active
                  ? t('schedule.ooo.active')
                  : t('schedule.ooo.inactive')}
              </span>
            </button>
          {/if}
        </li>
      {/each}
    </ul>
  {/if}
</div>

<style>
  .empty {
    color: var(--text-muted);
    font-size: var(--text-sm);
  }

  .timeline {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
  }

  .list {
    display: none;
    flex-direction: column;
    gap: var(--space-2);
    margin: 0;
    padding: 0;
    list-style: none;
  }

  @media (max-width: 767.98px) {
    .timeline {
      display: none;
    }

    .list {
      display: flex;
    }
  }

  .ticks {
    position: relative;
    height: 18px;
    color: var(--text-muted);
    font-size: var(--text-xs);
  }

  .tick-label {
    position: absolute;
    top: 0;
    padding-left: var(--space-1);
    white-space: nowrap;
  }

  .lanes {
    position: relative;
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    padding: 22px 0 var(--space-2);
    border-block: 1px solid var(--line);
    background: var(--surface-2);
    overflow: hidden;
  }

  .gridline {
    position: absolute;
    top: 0;
    bottom: 0;
    border-left: 1px dashed var(--line-strong);
    pointer-events: none;
  }

  .now {
    position: absolute;
    top: 0;
    bottom: 0;
    z-index: 2;
    border-left: 2px solid var(--mucki);
    pointer-events: none;
  }

  .now-label {
    position: absolute;
    top: 0;
    left: 3px;
    padding: 0 4px;
    border-radius: var(--radius-pill);
    background: var(--mucki);
    color: var(--on-mucki);
    font-size: 10px;
    font-weight: 700;
    line-height: 16px;
  }

  .lane {
    position: relative;
    height: 28px;
  }

  .bar {
    position: absolute;
    top: 0;
    bottom: 0;
    display: flex;
    align-items: center;
    overflow: hidden;
    margin: 0;
    padding: 0 var(--space-2);
    border: 1px solid color-mix(in srgb, var(--primary) 55%, transparent);
    border-radius: var(--radius-xs);
    background: var(--primary-soft);
    color: var(--text);
    font-size: var(--text-xs);
    font-weight: 600;
    text-align: left;
  }

  button.bar {
    cursor: pointer;
  }

  button.bar:hover {
    border-color: var(--primary);
  }

  .bar.clipped-start {
    border-left-style: dashed;
    border-top-left-radius: 0;
    border-bottom-left-radius: 0;
  }

  .bar.open-end {
    border-right: none;
    border-top-right-radius: 0;
    border-bottom-right-radius: 0;
    mask-image: linear-gradient(to right, #000 calc(100% - 64px), transparent);
  }

  .bar.inactive {
    border-style: dashed;
    background: repeating-linear-gradient(
      -45deg,
      var(--surface-3) 0 6px,
      var(--surface) 6px 12px
    );
    color: var(--text-muted);
    opacity: 0.7;
  }

  .bar-label {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .item {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-2);
    width: 100%;
    padding: var(--space-2) var(--space-3);
    border: 1px solid var(--line);
    border-radius: var(--radius-sm);
    background: var(--surface);
    color: var(--text);
    font-size: var(--text-sm);
    text-align: left;
  }

  button.item {
    cursor: pointer;
  }

  button.item:hover {
    border-color: var(--primary);
  }

  .item.inactive {
    color: var(--text-muted);
  }

  .item-range {
    font-variant-numeric: tabular-nums;
  }

  .badge {
    flex: none;
    padding: 1px var(--space-2);
    border-radius: var(--radius-pill);
    background: var(--ok-soft);
    color: var(--ok);
    font-size: var(--text-xs);
    font-weight: 700;
  }

  .badge.off {
    background: var(--surface-3);
    color: var(--text-muted);
  }

  button.bar:focus-visible,
  button.item:focus-visible {
    outline: 2px solid var(--focus);
    outline-offset: 2px;
  }
</style>
