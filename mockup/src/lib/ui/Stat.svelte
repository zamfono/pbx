<!--
  A key figure tile.
-->
<script lang="ts">
  import type { IconNode } from '@lucide/svelte';
  import type { Component } from 'svelte';

  import Icon from './Icon.svelte';

  type Props = {
    label: string;
    value: string | number;
    hint?: string;
    icon?: Component | IconNode;
    tone?: 'default' | 'primary' | 'lime' | 'mucki' | 'danger';
    href?: string;
  };

  let { label, value, hint, icon, tone = 'default', href }: Props = $props();
</script>

<svelte:element this={href ? 'a' : 'div'} class="stat {tone}" {href}>
  <div class="top">
    <span class="label">{label}</span>
    {#if icon}<span class="icon"><Icon {icon} size={18} /></span>{/if}
  </div>
  <div class="value nums">{value}</div>
  {#if hint}<div class="hint">{hint}</div>{/if}
</svelte:element>

<style>
  .stat {
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: var(--space-4) var(--space-5);
    background: var(--surface);
    border: 1px solid var(--line);
    border-radius: var(--radius-md);
    color: var(--text);
    text-decoration: none;
    box-shadow: var(--shadow-sm);
    transition: transform 0.15s var(--ease);
  }
  a.stat:hover {
    transform: translateY(-2px);
    text-decoration: none;
  }
  .top {
    display: flex;
    justify-content: space-between;
    align-items: center;
  }
  .label {
    font-size: var(--text-sm);
    font-weight: 700;
    color: var(--text-muted);
  }
  .icon {
    color: var(--text-faint);
  }
  .value {
    font-family: var(--font-display);
    font-size: 30px;
    font-weight: 800;
    letter-spacing: -0.03em;
  }
  .hint {
    font-size: var(--text-xs);
    color: var(--text-muted);
  }
  .primary {
    background: var(--primary);
    color: var(--on-primary);
    border-color: transparent;
  }
  .lime {
    background: var(--lime);
    color: var(--on-lime);
    border-color: transparent;
  }
  .mucki {
    background: var(--mucki);
    color: var(--on-mucki);
    border-color: transparent;
  }
  .primary .label,
  .primary .hint,
  .primary .icon,
  .lime .label,
  .lime .hint,
  .lime .icon,
  .mucki .label,
  .mucki .hint,
  .mucki .icon {
    color: inherit;
    opacity: 0.8;
  }
  .danger .value {
    color: var(--danger);
  }
</style>
