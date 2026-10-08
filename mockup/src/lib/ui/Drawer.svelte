<!--
  A side sheet for creating or editing one thing without leaving the list; full screen on phones.
-->
<script lang="ts">
  import X from '@lucide/svelte/icons/x';
  import type { Snippet } from 'svelte';

  import { t } from '#lib/i18n/index.svelte.js';

  type Props = {
    open: boolean;
    title: string;
    subtitle?: string;
    width?: number;
    onclose: () => void;
    children: Snippet;
    footer?: Snippet;
  };

  let {
    open,
    title,
    subtitle,
    width = 520,
    onclose,
    children,
    footer
  }: Props = $props();
  let element = $state<HTMLDialogElement>();

  $effect(() => {
    if (element === undefined) {
      return;
    }
    if (open && !element.open) {
      element.showModal();
    } else if (!open && element.open) {
      element.close();
    }
  });
</script>

<dialog
  bind:this={element}
  class="drawer"
  style:--drawer-width="{width}px"
  aria-label={title}
  oncancel={event => {
    event.preventDefault();
    onclose();
  }}
  onclick={event => {
    if (event.target === element) {
      onclose();
    }
  }}
>
  {#if open}
    <div class="inner">
      <header>
        <div class="titles">
          <h2>{title}</h2>
          {#if subtitle}<p>{subtitle}</p>{/if}
        </div>
        <button
          type="button"
          class="close"
          aria-label={t('common.close')}
          onclick={onclose}><X size={18} /></button
        >
      </header>
      <div class="body">{@render children()}</div>
      {#if footer}<footer>{@render footer()}</footer>{/if}
    </div>
  {/if}
</dialog>

<style>
  .drawer {
    margin: 0 0 0 auto;
    height: 100dvh;
    max-height: 100dvh;
    width: min(var(--drawer-width), 100vw);
    max-width: 100vw;
    padding: 0;
    border: 0;
    background: var(--bg);
    color: var(--text);
    box-shadow: var(--shadow-lg);
  }
  .drawer::backdrop {
    background: var(--overlay);
    backdrop-filter: blur(2px);
  }
  .drawer[open] {
    animation: slide 0.22s var(--ease);
  }
  @keyframes slide {
    from {
      transform: translateX(40px);
      opacity: 0;
    }
  }
  .inner {
    display: flex;
    flex-direction: column;
    height: 100%;
  }
  header {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: var(--space-3);
    padding: var(--space-5);
    border-bottom: 1px solid var(--line);
    background: var(--surface);
  }
  .titles p {
    color: var(--text-muted);
    font-size: var(--text-sm);
    margin-top: 4px;
  }
  .close {
    display: grid;
    place-items: center;
    width: 34px;
    height: 34px;
    border: 0;
    border-radius: 50%;
    background: var(--surface-3);
    color: var(--text-muted);
    cursor: pointer;
    flex: none;
  }
  .body {
    flex: 1;
    overflow-y: auto;
    padding: var(--space-5);
  }
  footer {
    display: flex;
    justify-content: flex-end;
    gap: var(--space-2);
    flex-wrap: wrap;
    padding: var(--space-4) var(--space-5);
    border-top: 1px solid var(--line);
    background: var(--surface);
  }
</style>
