<!--
  A modal dialog on the native <dialog> element: focus trap, Escape and backdrop click close it.
  Full-screen sheet on phones.
-->
<script lang="ts">
  import X from '@lucide/svelte/icons/x';
  import type { Snippet } from 'svelte';

  import { t } from '#lib/i18n/index.svelte.js';

  type Props = {
    open: boolean;
    title: string;
    size?: 'sm' | 'md' | 'lg';
    onclose: () => void;
    children: Snippet;
    footer?: Snippet;
  };

  let { open, title, size = 'md', onclose, children, footer }: Props = $props();
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
  class={size}
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
        <h2>{title}</h2>
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
  dialog {
    padding: 0;
    border: 0;
    border-radius: var(--radius-lg);
    background: var(--surface);
    color: var(--text);
    box-shadow: var(--shadow-lg);
    width: min(560px, calc(100vw - 32px));
    max-height: calc(100dvh - 48px);
  }
  dialog.sm {
    width: min(440px, calc(100vw - 32px));
  }
  dialog.lg {
    width: min(820px, calc(100vw - 32px));
  }
  dialog::backdrop {
    background: var(--overlay);
    backdrop-filter: blur(3px);
  }
  dialog[open] {
    animation: pop 0.18s var(--ease);
  }
  @keyframes pop {
    from {
      transform: translateY(8px) scale(0.98);
      opacity: 0;
    }
  }
  .inner {
    display: flex;
    flex-direction: column;
    max-height: calc(100dvh - 48px);
  }
  header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-3);
    padding: var(--space-5) var(--space-5) var(--space-3);
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
  }
  .body {
    padding: var(--space-2) var(--space-5) var(--space-5);
    overflow-y: auto;
  }
  footer {
    display: flex;
    justify-content: flex-end;
    flex-wrap: wrap;
    gap: var(--space-2);
    padding: var(--space-4) var(--space-5);
    border-top: 1px solid var(--line);
    background: var(--surface-2);
    border-radius: 0 0 var(--radius-lg) var(--radius-lg);
  }
  @media (max-width: 640px) {
    dialog,
    dialog.sm,
    dialog.lg {
      width: 100vw;
      max-width: 100vw;
      max-height: 92dvh;
      margin: auto 0 0;
      border-radius: var(--radius-lg) var(--radius-lg) 0 0;
    }
    .inner {
      max-height: 92dvh;
    }
    footer {
      border-radius: 0;
    }
  }
</style>
