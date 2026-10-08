<!--
  Tabs as links (`hrefFor`) or buttons (`onSelect`), scrolling horizontally on narrow screens.
-->
<script lang="ts">
  import type { IconNode } from '@lucide/svelte';
  import type { Component } from 'svelte';

  import { t } from '#lib/i18n/index.svelte.js';

  import ExpertTag from './ExpertTag.svelte';
  import Icon from './Icon.svelte';

  type Tab = {
    id: string;
    label: string;
    icon?: Component | IconNode;
    count?: number;
    expert?: boolean;
  };
  type Props = {
    tabs: Tab[];
    active: string;
    hrefFor?: (id: string) => string;
    onSelect?: (id: string) => void;
  };

  let { tabs, active, hrefFor, onSelect }: Props = $props();
</script>

<nav class="tabs" aria-label={t('common.tabs')}>
  {#each tabs as tab (tab.id)}
    {#if hrefFor}
      <a
        class="tab"
        class:on={tab.id === active}
        href={hrefFor(tab.id)}
        aria-current={tab.id === active ? 'page' : undefined}
      >
        {#if tab.icon}<Icon icon={tab.icon} size={16} />{/if}
        {tab.label}
        {#if tab.count !== undefined}<span class="count">{tab.count}</span>{/if}
        {#if tab.expert}<ExpertTag />{/if}
      </a>
    {:else}
      <button
        type="button"
        class="tab"
        class:on={tab.id === active}
        onclick={() => onSelect?.(tab.id)}
      >
        {#if tab.icon}<Icon icon={tab.icon} size={16} />{/if}
        {tab.label}
        {#if tab.count !== undefined}<span class="count">{tab.count}</span>{/if}
        {#if tab.expert}<ExpertTag />{/if}
      </button>
    {/if}
  {/each}
</nav>

<style>
  .tabs {
    display: flex;
    gap: 4px;
    border-bottom: 1.5px solid var(--line);
    margin-bottom: var(--space-5);
    overflow-x: auto;
    scrollbar-width: none;
  }
  .tab {
    display: inline-flex;
    align-items: center;
    gap: 7px;
    padding: 10px 14px;
    border: 0;
    background: transparent;
    color: var(--text-muted);
    font-weight: 700;
    font-size: var(--text-sm);
    white-space: nowrap;
    cursor: pointer;
    border-bottom: 2.5px solid transparent;
    margin-bottom: -1.5px;
    text-decoration: none;
  }
  .tab:hover {
    color: var(--text);
    text-decoration: none;
  }
  .tab.on {
    color: var(--primary);
    border-bottom-color: var(--primary);
  }
  .count {
    font-size: 11px;
    background: var(--surface-3);
    border-radius: var(--radius-pill);
    padding: 1px 7px;
  }
  .on .count {
    background: var(--primary-soft);
  }
</style>
