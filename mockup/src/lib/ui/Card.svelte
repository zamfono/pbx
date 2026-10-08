<!--
  A content card: optional header (icon, title, description, actions) and body.
-->
<script lang="ts">
  import type { IconNode } from '@lucide/svelte';
  import type { Component, Snippet } from 'svelte';

  import ExpertTag from './ExpertTag.svelte';
  import Icon from './Icon.svelte';

  type Props = {
    title?: string;
    description?: string;
    icon?: Component | IconNode;
    expert?: boolean;
    padded?: boolean;
    tone?: 'default' | 'primary' | 'lime' | 'mucki' | 'danger';
    id?: string;
    actions?: Snippet;
    children: Snippet;
  };

  let {
    title,
    description,
    icon,
    expert = false,
    padded = true,
    tone = 'default',
    id,
    actions,
    children
  }: Props = $props();
</script>

<section class="card {tone}" class:padded {id}>
  {#if title || actions}
    <header class="head">
      {#if icon}<span class="icon"><Icon {icon} size={18} /></span>{/if}
      <div class="titles">
        {#if title}
          <h3 class="row" style="--gap: 8px">
            {title}{#if expert}<ExpertTag />{/if}
          </h3>
        {/if}
        {#if description}<p class="desc">{description}</p>{/if}
      </div>
      {#if actions}<div class="actions">{@render actions()}</div>{/if}
    </header>
  {/if}
  <div class="body">{@render children()}</div>
</section>

<style>
  .card {
    background: var(--surface);
    border: 1px solid var(--line);
    border-radius: var(--radius-md);
    box-shadow: var(--shadow-sm);
    min-width: 0;
  }
  .padded {
    padding: var(--space-5);
  }
  .padded .head {
    margin-bottom: var(--space-4);
  }
  .card:not(.padded) .head {
    padding: var(--space-4) var(--space-5);
    border-bottom: 1px solid var(--line);
  }
  .head {
    display: flex;
    align-items: flex-start;
    gap: var(--space-3);
  }
  .icon {
    display: grid;
    place-items: center;
    width: 34px;
    height: 34px;
    border-radius: var(--radius-sm);
    background: var(--primary-soft);
    color: var(--primary);
    flex: none;
  }
  .titles {
    flex: 1;
    min-width: 0;
  }
  .desc {
    color: var(--text-muted);
    font-size: var(--text-sm);
    margin-top: 2px;
  }
  .actions {
    display: flex;
    gap: var(--space-2);
    align-items: center;
    flex-wrap: wrap;
  }
  .primary {
    background: var(--primary);
    color: var(--on-primary);
    border-color: transparent;
  }
  .primary .desc {
    color: inherit;
    opacity: 0.8;
  }
  .lime {
    background: var(--lime);
    color: var(--on-lime);
    border-color: transparent;
  }
  .mucki {
    background: var(--mucki-soft);
    border-color: transparent;
  }
  .danger {
    border-color: var(--danger);
  }
  @media (max-width: 640px) {
    .padded {
      padding: var(--space-4);
    }
    .head {
      flex-wrap: wrap;
    }
  }
</style>
