<!--
  A value the API returns once (a token, revealed credentials, a set-password link), with copy.
-->
<script lang="ts">
  import Check from '@lucide/svelte/icons/check';
  import Copy from '@lucide/svelte/icons/copy';

  import { t } from '#lib/i18n/index.svelte.js';

  type Props = {
    value: string;
    label?: string;
    note?: string;
    secret?: boolean;
  };
  let { value, label, note, secret = false }: Props = $props();
  let copied = $state(false);
  let revealed = $state(false);

  async function copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(value);
    } catch {
      // Clipboard blocked (insecure context): the value stays selectable.
    }
    copied = true;
    setTimeout(() => (copied = false), 1600);
  }
</script>

<div class="otv">
  {#if label}<span class="label">{label}</span>{/if}
  <div class="box">
    {#if secret && !revealed}
      <button type="button" class="reveal" onclick={() => (revealed = true)}
        ><code class="blurred">{value}</code></button
      >
    {:else}
      <code>{value}</code>
    {/if}
    <button
      type="button"
      class="copy"
      onclick={copy}
      aria-label={t('common.copy')}
    >
      {#if copied}<Check size={15} />{:else}<Copy size={15} />{/if}
      {copied ? t('common.copied') : t('common.copy')}
    </button>
  </div>
  {#if note}<p class="note">{note}</p>{/if}
</div>

<style>
  .otv {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .label {
    font-size: var(--text-xs);
    font-weight: 700;
    color: var(--text-muted);
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }
  .box {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    background: var(--surface-3);
    border-radius: var(--radius-sm);
    padding: 8px 8px 8px 12px;
  }
  code {
    flex: 1;
    min-width: 0;
    overflow-wrap: anywhere;
    font-size: 12.5px;
    cursor: text;
    user-select: all;
  }
  .reveal {
    flex: 1;
    min-width: 0;
    border: 0;
    background: transparent;
    padding: 0;
    text-align: left;
    cursor: pointer;
  }
  .blurred {
    filter: blur(5px);
    cursor: pointer;
    user-select: none;
  }
  .copy {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    border: 0;
    border-radius: var(--radius-pill);
    background: var(--surface);
    padding: 6px 10px;
    font-weight: 700;
    font-size: var(--text-xs);
    cursor: pointer;
    flex: none;
  }
  .note {
    font-size: var(--text-xs);
    color: var(--warn);
    font-weight: 700;
  }
</style>
