<!--
  A batch in progress: "3 / 8 angelegt", a bar, and each row's outcome; failed rows say why.
-->
<script lang="ts">
  import Check from '@lucide/svelte/icons/check';
  import CircleX from '@lucide/svelte/icons/circle-x';
  import LoaderCircle from '@lucide/svelte/icons/loader-circle';

  import { t } from '#lib/i18n/index.svelte.js';
  import { isExpert } from '#lib/state/session.svelte.js';

  import type { ProgressMessage } from './types';

  let { message }: { message: ProgressMessage } = $props();

  const total = $derived(message.items.length);
  const done = $derived(
    message.items.filter(item => item.state === 'done').length
  );
  const handled = $derived(
    message.items.filter(
      item => item.state === 'done' || item.state === 'failed'
    ).length
  );
  const percent = $derived(
    total === 0 ? 0 : Math.round((handled / total) * 100)
  );
</script>

<div class="progress" class:finished={message.finished}>
  <div class="head">
    <strong class="nums">{t(message.labelKey, { done, total })}</strong>
    {#if isExpert() && message.operation}<code
        >{message.operation} × {total}</code
      >{/if}
  </div>
  <div
    class="bar"
    role="progressbar"
    aria-valuemin="0"
    aria-valuemax={total}
    aria-valuenow={handled}
    aria-label={t(message.labelKey, { done, total })}
  >
    <span style:width="{percent}%"></span>
  </div>
  <ul>
    {#each message.items as item, index (index)}
      <li class={item.state}>
        <span class="icon" aria-hidden="true">
          {#if item.state === 'done'}
            <Check size={13} />
          {:else if item.state === 'failed'}
            <CircleX size={13} />
          {:else if item.state === 'running'}
            <LoaderCircle size={13} class="spin" />
          {:else}
            <span class="dot"></span>
          {/if}
        </span>
        <span class="label">{item.label}</span>
        {#if item.note}<span class="note">{item.note}</span>{/if}
      </li>
    {/each}
  </ul>
</div>

<style>
  .progress {
    background: var(--surface);
    border: 1px solid var(--line);
    border-radius: var(--radius-md);
    padding: 12px 14px;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .head {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 8px;
  }
  .head strong {
    font-family: var(--font-display);
    font-size: var(--text-lg);
  }
  .head code {
    font-family: var(--font-mono);
    font-size: 11px;
    color: var(--mucki-text);
  }
  .bar {
    height: 6px;
    background: var(--surface-3);
    border-radius: var(--radius-pill);
    overflow: hidden;
  }
  .bar span {
    display: block;
    height: 100%;
    background: var(--mucki);
    border-radius: inherit;
    transition: width 0.35s var(--ease);
  }
  .finished .bar span {
    background: var(--ok);
  }
  ul {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 3px;
    font-family: var(--font-mono);
    font-size: 11.5px;
  }
  li {
    display: grid;
    grid-template-columns: 16px 1fr;
    column-gap: 6px;
    align-items: center;
    color: var(--text-muted);
  }
  li.done {
    color: var(--text);
  }
  li.failed {
    color: var(--danger);
  }
  .icon {
    display: inline-grid;
    place-items: center;
  }
  .done .icon {
    color: var(--ok);
  }
  .running .icon {
    color: var(--mucki);
  }
  .icon :global(.spin) {
    animation: spin 0.9s linear infinite;
  }
  .dot {
    width: 5px;
    height: 5px;
    border-radius: 50%;
    background: var(--line-strong);
  }
  .note {
    grid-column: 2;
    font-family: var(--font-body);
    font-size: var(--text-xs);
  }
  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }
</style>
