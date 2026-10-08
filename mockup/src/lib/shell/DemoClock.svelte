<!--
  The demo bar's clock: the demo's current date and time, and the moments it can restart at
  (`clock.svelte.ts`). Highlighted while a moment other than now is set, so nobody takes the demo
  time for the real one. The menu is fixed, as the bar scrolls sideways and would clip it, and
  opens under the chip, kept inside the window.
-->
<script lang="ts">
  import Check from '@lucide/svelte/icons/check';
  import Clock from '@lucide/svelte/icons/clock-3';
  import { onMount } from 'svelte';

  import {
    clock,
    momentInstant,
    MOMENTS,
    now,
    setMoment,
    type Moment
  } from '#lib/clock.svelte.js';
  import { i18n, t } from '#lib/i18n/index.svelte.js';
  import { resetDemo } from '#lib/state/demo.js';
  import { go } from '#lib/state/router.svelte.js';
  import { confirmDialog } from '#lib/state/ui.svelte.js';

  const MENU_WIDTH = 400;
  const EDGE = 12;

  let open = $state(false);
  let root = $state<HTMLDivElement>();
  let menuLeft = $state(EDGE);

  function placeMenu(chip: HTMLElement): void {
    const width = Math.min(MENU_WIDTH, window.innerWidth - 2 * EDGE);
    const left = chip.getBoundingClientRect().left;
    menuLeft = Math.max(EDGE, Math.min(left, window.innerWidth - width - EDGE));
  }
  let tick = $state(0);

  onMount(() => {
    const timer = setInterval(() => (tick += 1), 15_000);
    return () => clearInterval(timer);
  });

  const locale = $derived(i18n.locale === 'de' ? 'de-DE' : 'en-GB');
  const format = (ms: number, withDate: boolean): string =>
    new Intl.DateTimeFormat(locale, {
      timeZone: 'Europe/Berlin',
      ...(withDate ? { weekday: 'short', day: 'numeric', month: 'short' } : {}),
      hour: '2-digit',
      minute: '2-digit'
    }).format(new Date(ms));
  const current = $derived.by(() => {
    void tick;
    return format(now(), clock.moment !== 'now');
  });
  const simulated = $derived(clock.moment !== 'now');

  async function choose(moment: Moment): Promise<void> {
    open = false;
    const when =
      moment === 'now'
        ? t('demo.time.realTime')
        : format(momentInstant(moment), true);
    const confirmed = await confirmDialog({
      title: t('demo.time.confirmTitle'),
      body: t('demo.time.confirmBody', {
        moment: t(`demo.time.moment.${moment}`),
        when
      }),
      confirmLabel: t('demo.time.confirmAction'),
      cancelLabel: t('common.cancel'),
      tone: 'primary',
      note: null
    });
    if (confirmed) {
      setMoment(moment);
      resetDemo();
      go('/overview');
    }
  }
</script>

<svelte:window
  onresize={() => (open = false)}
  onclick={event => {
    if (open && root && !root.contains(event.target as Node)) {
      open = false;
    }
  }}
  onkeydown={event => {
    if (event.key === 'Escape') {
      open = false;
    }
  }}
/>

<div class="clock" bind:this={root}>
  <button
    type="button"
    class="chip"
    class:simulated
    aria-haspopup="menu"
    aria-expanded={open}
    title={simulated ? t('demo.time.simulatedTitle') : t('demo.time.title')}
    onclick={event => {
      event.stopPropagation();
      placeMenu(event.currentTarget);
      open = !open;
    }}
  >
    <Clock size={13} />
    <span class="nums">{current}</span>
  </button>
  {#if open}
    <div class="menu" role="menu" style:left="{menuLeft}px">
      <p class="head">{t('demo.time.title')}</p>
      <p class="sub">{t('demo.time.subtitle')}</p>
      {#each MOMENTS as moment (moment)}
        <button
          type="button"
          role="menuitem"
          class="item"
          class:on={clock.moment === moment}
          onclick={() => choose(moment)}
        >
          <span class="check"
            >{#if clock.moment === moment}<Check size={14} />{/if}</span
          >
          <span class="text">
            <span class="name">{t(`demo.time.moment.${moment}`)}</span>
            <span class="desc">{t(`demo.time.moment.${moment}.desc`)}</span>
          </span>
          <span class="when nums"
            >{moment === 'now'
              ? t('demo.time.realTime')
              : format(momentInstant(moment), true)}</span
          >
        </button>
      {/each}
    </div>
  {/if}
</div>

<style>
  .clock {
    position: relative;
  }
  .chip {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    border: 1px solid rgb(255 255 255 / 15%);
    background: transparent;
    color: inherit;
    border-radius: var(--radius-pill);
    padding: 3px 10px;
    cursor: pointer;
    white-space: nowrap;
    font-weight: 700;
    font-size: 12px;
  }
  .chip:hover {
    background: rgb(255 255 255 / 10%);
  }
  .chip.simulated {
    background: var(--demo-accent);
    color: var(--on-lime);
    border-color: transparent;
  }
  .menu {
    position: fixed;
    top: calc(var(--demobar-height) + 4px);
    z-index: 120;
    width: min(400px, calc(100vw - 24px));
    padding: 8px;
    background: var(--surface);
    color: var(--text);
    border: 1px solid var(--line);
    border-radius: var(--radius-md);
    box-shadow: var(--shadow-lg);
  }
  .head {
    font-family: var(--font-display);
    font-weight: 800;
    font-size: var(--text-lg);
    padding: 6px 10px 0;
  }
  .sub {
    font-size: var(--text-xs);
    color: var(--text-muted);
    padding: 2px 10px 8px;
  }
  .item {
    display: grid;
    grid-template-columns: 18px minmax(0, 1fr) auto;
    align-items: center;
    gap: 10px;
    width: 100%;
    padding: 9px 10px;
    border: 0;
    border-radius: var(--radius-sm);
    background: transparent;
    color: var(--text);
    text-align: left;
    cursor: pointer;
  }
  .item:hover,
  .item:focus-visible {
    background: var(--surface-3);
  }
  .item.on {
    background: var(--primary-soft);
  }
  .check {
    color: var(--primary);
    display: grid;
  }
  .text {
    display: flex;
    flex-direction: column;
    min-width: 0;
  }
  .name {
    font-weight: 700;
    font-size: var(--text-sm);
  }
  .desc {
    font-size: var(--text-xs);
    color: var(--text-muted);
  }
  .when {
    font-size: var(--text-xs);
    color: var(--text-muted);
    white-space: nowrap;
  }
</style>
