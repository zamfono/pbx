<!--
  A small status pill.
-->
<script lang="ts">
  import type { IconNode } from '@lucide/svelte';
  import type { Component, Snippet } from 'svelte';

  import Icon from './Icon.svelte';

  type Props = {
    tone?:
      | 'neutral'
      | 'primary'
      | 'ok'
      | 'warn'
      | 'danger'
      | 'info'
      | 'lime'
      | 'mucki';
    icon?: Component | IconNode;
    dot?: boolean;
    title?: string;
    children: Snippet;
  };

  let {
    tone = 'neutral',
    icon,
    dot = false,
    title,
    children
  }: Props = $props();
</script>

<span class="badge {tone}" {title}>
  {#if dot}<span class="dot"></span>{/if}
  {#if icon}<Icon {icon} size={12} strokeWidth={2.5} />{/if}
  {@render children()}
</span>

<style>
  .badge {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    font-size: var(--text-xs);
    font-weight: 700;
    line-height: 1;
    padding: 4px 9px;
    border-radius: var(--radius-pill);
    white-space: nowrap;
  }
  .dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: currentColor;
  }
  .neutral {
    background: var(--surface-3);
    color: var(--text-muted);
  }
  .primary {
    background: var(--primary-soft);
    color: var(--primary);
  }
  .ok {
    background: var(--ok-soft);
    color: var(--ok);
  }
  .warn {
    background: var(--warn-soft);
    color: var(--warn);
  }
  .danger {
    background: var(--danger-soft);
    color: var(--danger);
  }
  .info {
    background: var(--info-soft);
    color: var(--info);
  }
  .lime {
    background: var(--lime);
    color: var(--on-lime);
  }
  .mucki {
    background: var(--mucki-soft);
    color: var(--mucki-text);
  }
</style>
