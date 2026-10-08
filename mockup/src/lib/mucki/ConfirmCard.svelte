<!--
  What an operation with a confirmation will do, before it runs: Confirm / Cancel. The operation
  runs only after Confirm, with `confirmed: true`.
-->
<script lang="ts">
  import CircleCheck from '@lucide/svelte/icons/circle-check';
  import CircleX from '@lucide/svelte/icons/circle-x';
  import TriangleAlert from '@lucide/svelte/icons/triangle-alert';

  import { t } from '#lib/i18n/index.svelte.js';
  import { isExpert } from '#lib/state/session.svelte.js';
  import Button from '#lib/ui/Button.svelte';

  import type { ConfirmMessage } from './types';

  let {
    message,
    ondecide
  }: { message: ConfirmMessage; ondecide: (confirmed: boolean) => void } =
    $props();
</script>

<div
  class="confirm {message.state}"
  class:destructive={message.destructive}
  role="group"
  aria-label={message.title}
>
  <span class="kicker"
    >{t('mucki.confirm.label')}{#if isExpert()}<code>{message.operation}</code
      >{/if}</span
  >
  <strong class="title">{message.title}</strong>
  <p class="body">{message.body}</p>
  {#if message.irreversible}
    <p class="note">
      <TriangleAlert size={14} />
      {t('mucki.confirm.irreversible')}
    </p>
  {/if}
  {#if message.state === 'pending'}
    <div class="actions">
      <Button
        variant={message.destructive ? 'danger' : 'mucki'}
        size="sm"
        op={message.operation}
        onclick={() => ondecide(true)}
      >
        {message.action}
      </Button>
      <Button variant="ghost" size="sm" onclick={() => ondecide(false)}
        >{t('mucki.confirm.cancel')}</Button
      >
    </div>
    <p class="hint">{t('mucki.confirm.nothingYet')}</p>
  {:else if message.state === 'confirmed'}
    <span class="decided ok"
      ><CircleCheck size={15} /> {t('mucki.confirm.confirmed')}</span
    >
  {:else}
    <span class="decided"
      ><CircleX size={15} /> {t('mucki.confirm.cancelled')}</span
    >
  {/if}
</div>

<style>
  .confirm {
    border: 1.5px solid var(--mucki);
    background: var(--surface);
    border-radius: var(--radius-md);
    padding: 12px 14px;
    display: flex;
    flex-direction: column;
    gap: 6px;
    box-shadow: var(--shadow-sm);
  }
  .confirm.destructive {
    border-color: var(--danger);
  }
  .confirm:not(.pending) {
    border-color: var(--line);
    box-shadow: none;
  }
  .kicker {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: var(--text-xs);
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--mucki-text);
  }
  .kicker code {
    font-family: var(--font-mono);
    font-weight: 500;
    text-transform: none;
    letter-spacing: 0;
    color: var(--text-muted);
  }
  .title {
    font-family: var(--font-display);
    font-size: var(--text-lg);
    font-weight: 700;
  }
  .body {
    margin: 0;
    color: var(--text-muted);
  }
  .note {
    margin: 0;
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: var(--text-sm);
    color: var(--warn);
    font-weight: 600;
  }
  .actions {
    display: flex;
    gap: var(--space-2);
    flex-wrap: wrap;
    margin-top: 4px;
  }
  .hint {
    margin: 0;
    font-size: var(--text-xs);
    color: var(--text-faint);
  }
  .decided {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-size: var(--text-sm);
    font-weight: 700;
    color: var(--text-muted);
  }
  .decided.ok {
    color: var(--ok);
  }
</style>
