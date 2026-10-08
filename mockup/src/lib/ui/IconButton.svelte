<!--
  A round icon-only button; `label` is its accessible name and tooltip.
-->
<script lang="ts">
  import type { IconNode } from '@lucide/svelte';
  import type { Component } from 'svelte';

  import Icon from './Icon.svelte';

  type Props = {
    icon: Component | IconNode;
    label: string;
    variant?: 'ghost' | 'soft' | 'danger' | 'primary';
    size?: 'sm' | 'md';
    disabled?: boolean;
    active?: boolean;
    onclick?: (event: MouseEvent) => void;
  };

  let {
    icon,
    label,
    variant = 'ghost',
    size = 'md',
    disabled = false,
    active = false,
    onclick
  }: Props = $props();
</script>

<button
  type="button"
  class="ib {variant} {size}"
  class:active
  title={label}
  aria-label={label}
  aria-pressed={active}
  {disabled}
  {onclick}
>
  <Icon {icon} size={size === 'sm' ? 15 : 18} />
</button>

<style>
  .ib {
    display: inline-grid;
    place-items: center;
    border: 0;
    border-radius: var(--radius-pill);
    cursor: pointer;
    color: var(--text-muted);
    background: transparent;
    transition:
      background 0.15s var(--ease),
      color 0.15s var(--ease);
    flex: none;
  }
  .md {
    width: 36px;
    height: 36px;
  }
  .sm {
    width: 28px;
    height: 28px;
  }
  .ghost:hover:not(:disabled),
  .active {
    background: var(--surface-3);
    color: var(--text);
  }
  .soft {
    background: var(--primary-soft);
    color: var(--primary);
  }
  .primary {
    background: var(--primary);
    color: var(--on-primary);
  }
  .danger:hover:not(:disabled) {
    background: var(--danger-soft);
    color: var(--danger);
  }
  .ib:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }
</style>
