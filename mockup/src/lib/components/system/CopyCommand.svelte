<!--
  A command or URL to copy, shown in a code line with a copy button.
-->
<script lang="ts">
  import Check from '@lucide/svelte/icons/check';
  import Copy from '@lucide/svelte/icons/copy';

  import { t } from '#lib/i18n/index.svelte.js';

  let { value, label }: { value: string; label?: string } = $props();
  let copied = $state(false);

  async function copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(value);
    } catch {
      // Clipboard blocked: the text stays selectable.
    }
    copied = true;
    setTimeout(() => (copied = false), 1600);
  }
</script>

<div class="command">
  {#if label}<span class="label">{label}</span>{/if}
  <div class="line">
    <code>{value}</code>
    <button
      type="button"
      class="copy"
      class:copied
      onclick={copy}
      aria-label={t('common.copy')}
    >
      {#if copied}<Check size={15} />{t('common.copied')}{:else}<Copy
          size={15}
        />{t('common.copy')}{/if}
    </button>
  </div>
</div>

<style>
  .command {
    display: flex;
    flex-direction: column;
    gap: 6px;
    min-width: 0;
  }
  .label {
    font-size: var(--text-xs);
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--text-muted);
  }
  .line {
    display: flex;
    align-items: stretch;
    border: 1px solid var(--line-strong);
    border-radius: var(--radius-sm);
    background: var(--surface-2);
    overflow: hidden;
  }
  code {
    flex: 1;
    min-width: 0;
    padding: 10px 12px;
    font-size: 12.5px;
    overflow-x: auto;
    white-space: nowrap;
    scrollbar-width: thin;
  }
  .copy {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    border: 0;
    border-left: 1px solid var(--line);
    background: var(--surface);
    color: var(--primary);
    font-weight: 700;
    font-size: var(--text-sm);
    padding: 0 14px;
    cursor: pointer;
    white-space: nowrap;
  }
  .copy:hover {
    background: var(--primary-soft);
  }
  .copy.copied {
    color: var(--ok);
  }
</style>
