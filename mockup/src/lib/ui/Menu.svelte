<!--
  A small action menu behind a "more" button.
-->
<script lang="ts">
  import type { IconNode } from '@lucide/svelte';
  import EllipsisVertical from '@lucide/svelte/icons/ellipsis-vertical';
  import type { Component } from 'svelte';

  import { t } from '#lib/i18n/index.svelte.js';

  import Icon from './Icon.svelte';

  export type MenuItem = {
    label: string;
    icon?: Component | IconNode;
    danger?: boolean;
    op?: string;
    onclick: () => void;
  };

  let { items, label }: { items: MenuItem[]; label?: string } = $props();
  let open = $state(false);
  let root = $state<HTMLDivElement>();
</script>

<svelte:window
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

{#if items.length > 0}
  <div class="menu" bind:this={root}>
    <button
      type="button"
      class="trigger"
      aria-haspopup="menu"
      aria-expanded={open}
      aria-label={label ?? t('common.more')}
      title={label ?? t('common.more')}
      onclick={event => {
        event.stopPropagation();
        open = !open;
      }}
    >
      <EllipsisVertical size={18} />
    </button>
    {#if open}
      <ul role="menu">
        {#each items as item (item.label)}
          <li role="none">
            <button
              type="button"
              role="menuitem"
              class:danger={item.danger}
              onclick={event => {
                event.stopPropagation();
                open = false;
                item.onclick();
              }}
            >
              {#if item.icon}<Icon icon={item.icon} size={16} />{/if}
              <span class="grow">{item.label}</span>
            </button>
          </li>
        {/each}
      </ul>
    {/if}
  </div>
{/if}

<style>
  .menu {
    position: relative;
    display: inline-block;
  }
  .trigger {
    display: grid;
    place-items: center;
    width: 34px;
    height: 34px;
    border: 0;
    border-radius: 50%;
    background: transparent;
    color: var(--text-muted);
    cursor: pointer;
  }
  .trigger:hover {
    background: var(--surface-3);
    color: var(--text);
  }
  ul {
    position: absolute;
    right: 0;
    top: calc(100% + 4px);
    z-index: 50;
    min-width: 220px;
    list-style: none;
    margin: 0;
    padding: 6px;
    background: var(--surface);
    border: 1px solid var(--line);
    border-radius: var(--radius-md);
    box-shadow: var(--shadow-lg);
  }
  li button {
    display: flex;
    align-items: center;
    gap: 10px;
    width: 100%;
    padding: 8px 10px;
    border: 0;
    background: transparent;
    border-radius: var(--radius-sm);
    text-align: left;
    cursor: pointer;
    font-size: var(--text-sm);
    font-weight: 500;
  }
  li button:hover {
    background: var(--surface-3);
  }
  .danger {
    color: var(--danger);
  }
</style>
