<!--
  The button. `op` names the operation it runs, for readers of the code; it is not displayed.
-->
<script lang="ts">
  import type { IconNode } from '@lucide/svelte';
  import type { Component, Snippet } from 'svelte';

  import Icon from './Icon.svelte';

  type Props = {
    variant?:
      'primary' | 'secondary' | 'ghost' | 'danger' | 'mucki' | 'lime' | 'soft';
    size?: 'sm' | 'md' | 'lg';
    icon?: Component | IconNode;
    iconRight?: Component | IconNode;
    loading?: boolean;
    disabled?: boolean;
    full?: boolean;
    href?: string;
    type?: 'button' | 'submit';
    title?: string;
    ariaLabel?: string;
    op?: string;
    onclick?: (event: MouseEvent) => void;
    children?: Snippet;
  };

  let {
    variant = 'secondary',
    size = 'md',
    icon,
    iconRight,
    loading = false,
    disabled = false,
    full = false,
    href,
    type = 'button',
    title,
    ariaLabel,
    op: _op,
    onclick,
    children
  }: Props = $props();

  const iconSize = $derived(size === 'sm' ? 15 : size === 'lg' ? 19 : 17);
</script>

{#snippet content()}
  {#if loading}
    <span class="spinner" aria-hidden="true"></span>
  {:else if icon}
    <Icon {icon} size={iconSize} />
  {/if}
  {#if children}<span class="label">{@render children()}</span>{/if}
  {#if iconRight}<Icon icon={iconRight} size={iconSize} />{/if}
{/snippet}

{#if href !== undefined && !disabled}
  <a
    class="btn {variant} {size}"
    class:full
    {href}
    {title}
    aria-label={ariaLabel}
  >
    {@render content()}
  </a>
{:else}
  <button
    class="btn {variant} {size}"
    class:full
    {type}
    disabled={disabled || loading}
    {title}
    aria-label={ariaLabel}
    {onclick}
  >
    {@render content()}
  </button>
{/if}

<style>
  .btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 7px;
    border: 1px solid transparent;
    border-radius: var(--radius-pill);
    font-weight: 700;
    cursor: pointer;
    white-space: nowrap;
    text-decoration: none;
    transition:
      background 0.15s var(--ease),
      transform 0.1s var(--ease),
      box-shadow 0.15s var(--ease),
      border-color 0.15s var(--ease);
    user-select: none;
  }
  .btn:hover {
    text-decoration: none;
  }
  .btn:active:not(:disabled) {
    transform: translateY(1px) scale(0.99);
  }
  .btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
  .full {
    width: 100%;
  }
  .sm {
    font-size: var(--text-sm);
    padding: 5px 12px;
    min-height: 30px;
  }
  .md {
    font-size: var(--text-md);
    padding: 8px 16px;
    min-height: 38px;
  }
  .lg {
    font-size: var(--text-lg);
    padding: 11px 22px;
    min-height: 46px;
  }
  .primary {
    background: var(--primary);
    color: var(--on-primary);
    box-shadow: var(--shadow-primary);
  }
  .primary:hover:not(:disabled) {
    background: var(--primary-hover);
  }
  .secondary {
    background: var(--surface);
    color: var(--text);
    border-color: var(--line-strong);
  }
  .secondary:hover:not(:disabled) {
    border-color: var(--primary);
    color: var(--primary);
  }
  .ghost {
    background: transparent;
    color: var(--text-muted);
  }
  .ghost:hover:not(:disabled) {
    background: var(--surface-3);
    color: var(--text);
  }
  .soft {
    background: var(--primary-soft);
    color: var(--primary);
  }
  .soft:hover:not(:disabled) {
    background: var(--surface-3);
  }
  .danger {
    background: var(--danger);
    color: #fff;
  }
  .danger:hover:not(:disabled) {
    filter: brightness(1.08);
  }
  .mucki {
    background: var(--mucki);
    color: var(--on-mucki);
  }
  .mucki:hover:not(:disabled) {
    background: var(--mucki-hover);
  }
  .lime {
    background: var(--lime);
    color: var(--on-lime);
  }
  .lime:hover:not(:disabled) {
    filter: brightness(0.97);
  }
  .spinner {
    width: 14px;
    height: 14px;
    border-radius: 50%;
    border: 2px solid currentColor;
    border-right-color: transparent;
    animation: spin 0.7s linear infinite;
  }
  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }
</style>
