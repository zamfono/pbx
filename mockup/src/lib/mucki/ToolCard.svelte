<!--
  One operation Mucki ran: a one-line summary in plain words; in Expert mode the operation's name
  and its raw input and result.
-->
<script lang="ts">
  import Ban from '@lucide/svelte/icons/ban';
  import Check from '@lucide/svelte/icons/check';
  import ChevronDown from '@lucide/svelte/icons/chevron-down';
  import LoaderCircle from '@lucide/svelte/icons/loader-circle';
  import ShieldAlert from '@lucide/svelte/icons/shield-alert';
  import TriangleAlert from '@lucide/svelte/icons/triangle-alert';
  import Wrench from '@lucide/svelte/icons/wrench';

  import { t } from '#lib/i18n/index.svelte.js';
  import { isExpert } from '#lib/state/session.svelte.js';

  import type { ToolMessage } from './types';

  let { message }: { message: ToolMessage } = $props();

  const expert = $derived(isExpert());
  const inputJson = $derived(JSON.stringify(message.input, null, 2));
  const errorJson = $derived(
    message.error === undefined ? null : JSON.stringify(message.error, null, 2)
  );
</script>

<div class="tool {message.state}">
  <div class="line">
    <span class="icon" aria-hidden="true">
      {#if message.state === 'running'}
        <LoaderCircle size={15} class="spin" />
      {:else if message.state === 'awaiting'}
        <Wrench size={15} />
      {:else if message.state === 'done'}
        <Check size={15} />
      {:else if message.state === 'refused'}
        <ShieldAlert size={15} />
      {:else if message.state === 'error'}
        <TriangleAlert size={15} />
      {:else}
        <Ban size={15} />
      {/if}
    </span>
    <span class="summary">{message.summary}</span>
    {#if expert}
      <span class="state">{t(`mucki.tool.state.${message.state}`)}</span>
    {/if}
  </div>
  {#if expert}
    <details>
      <summary>
        <code class="op">{message.operation}</code>
        <ChevronDown size={14} />
      </summary>
      <div class="raw">
        <span class="raw-label">{t('mucki.tool.input')}</span>
        <pre>{inputJson}</pre>
        {#if message.result !== undefined}
          <span class="raw-label">{t('mucki.tool.result')}</span>
          <pre>{message.result}</pre>
        {/if}
        {#if errorJson !== null}
          <span class="raw-label">{t('mucki.tool.result')}</span>
          <pre>{errorJson}</pre>
        {/if}
      </div>
    </details>
  {/if}
</div>

<style>
  .tool {
    --tone: var(--text-faint);
    font-family: var(--font-mono);
    font-size: 12px;
    border: 1px solid var(--line);
    border-left: 3px solid var(--tone);
    background: var(--surface);
    border-radius: var(--radius-sm);
    padding: 7px 10px;
    display: flex;
    flex-direction: column;
    gap: 6px;
    min-width: 0;
  }
  .running,
  .awaiting {
    --tone: var(--mucki);
  }
  .done {
    --tone: var(--ok);
  }
  .refused {
    --tone: var(--danger);
  }
  .error {
    --tone: var(--warn);
  }
  .line {
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
  }
  .icon {
    display: inline-grid;
    place-items: center;
    color: var(--tone);
    flex: none;
  }
  .icon :global(.spin) {
    animation: spin 0.9s linear infinite;
  }
  .summary {
    flex: 1;
    min-width: 0;
    color: var(--text);
    overflow-wrap: anywhere;
  }
  .cancelled .summary {
    color: var(--text-muted);
  }
  .state {
    flex: none;
    font-size: 10.5px;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--tone);
  }
  details summary {
    display: flex;
    align-items: center;
    gap: 4px;
    cursor: pointer;
    list-style: none;
    color: var(--text-muted);
  }
  details summary::-webkit-details-marker {
    display: none;
  }
  details[open] summary :global(svg) {
    transform: rotate(180deg);
  }
  .op {
    font-weight: 500;
    color: var(--mucki-text);
  }
  .raw {
    display: flex;
    flex-direction: column;
    gap: 4px;
    margin-top: 6px;
  }
  .raw-label {
    font-size: 10.5px;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--text-faint);
  }
  pre {
    margin: 0;
    max-height: 220px;
    overflow: auto;
    background: var(--surface-3);
    border-radius: var(--radius-xs);
    padding: 8px;
    font-size: 11px;
    line-height: 1.45;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .icon :global(.spin) {
      animation-duration: 3s;
    }
  }
</style>
