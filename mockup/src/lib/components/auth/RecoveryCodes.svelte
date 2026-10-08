<!--
  Freshly issued recovery codes, shown this once: the list, copy, a .txt download. With
  `oncontinue`, the "I have saved them" confirmation gates the way on (the sign-in's enrolment).
-->
<script lang="ts">
  import Check from '@lucide/svelte/icons/check';
  import Copy from '@lucide/svelte/icons/copy';
  import Download from '@lucide/svelte/icons/download';
  import TriangleAlert from '@lucide/svelte/icons/triangle-alert';

  import { t } from '#lib/i18n/index.svelte.js';
  import Button from '#lib/ui/Button.svelte';

  import { recoveryCodesText } from './mfa';

  type Props = {
    codes: string[];
    companyName: string;
    continueLabel?: string;
    oncontinue?: () => void;
  };
  let { codes, companyName, continueLabel, oncontinue }: Props = $props();

  let copied = $state(false);
  let saved = $state(false);
  const text = $derived(recoveryCodesText(companyName, codes));
  const download = $derived(
    `data:text/plain;charset=utf-8,${encodeURIComponent(text)}`
  );

  async function copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // Clipboard blocked (insecure context): the codes stay selectable.
    }
    copied = true;
    setTimeout(() => (copied = false), 1800);
  }
</script>

<div class="codes-block">
  <p class="intro">{t('auth.codes.intro')}</p>
  <p class="once"><TriangleAlert size={15} /> {t('auth.codes.once')}</p>
  <ol class="codes" aria-label={t('auth.codes.title')}>
    {#each codes as code, index (code)}
      <li><span class="index nums">{index + 1}</span><code>{code}</code></li>
    {/each}
  </ol>
  <div class="actions">
    <Button size="sm" icon={copied ? Check : Copy} onclick={copy}
      >{copied ? t('common.copied') : t('common.copy')}</Button
    >
    <a class="download" href={download} download="recovery-codes.txt"
      ><Download size={15} /> {t('auth.codes.download')}</a
    >
  </div>
  {#if oncontinue}
    <label class="saved">
      <input type="checkbox" bind:checked={saved} />
      <span>{t('auth.codes.saved')}</span>
    </label>
    <Button
      variant="primary"
      size="lg"
      full
      disabled={!saved}
      onclick={oncontinue}>{continueLabel ?? t('auth.codes.continue')}</Button
    >
  {/if}
</div>

<style>
  .codes-block {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
  }
  .intro {
    color: var(--text-muted);
  }
  .once {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: var(--text-sm);
    font-weight: 700;
    color: var(--warn);
    background: var(--warn-soft);
    padding: 8px 12px;
    border-radius: var(--radius-sm);
  }
  .codes {
    list-style: none;
    margin: 0;
    padding: var(--space-3);
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 6px var(--space-4);
    background: var(--surface-3);
    border-radius: var(--radius-md);
    border: 1px dashed var(--line-strong);
  }
  .codes li {
    display: flex;
    align-items: baseline;
    gap: 8px;
    min-width: 0;
  }
  .index {
    font-size: var(--text-xs);
    color: var(--text-faint);
    width: 1.4em;
    text-align: right;
    flex: none;
  }
  code {
    font-size: var(--text-sm);
    letter-spacing: 0.02em;
    white-space: nowrap;
    user-select: all;
  }
  .actions {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: var(--space-3);
  }
  .download {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-weight: 700;
    font-size: var(--text-sm);
  }
  .saved {
    display: flex;
    align-items: flex-start;
    gap: 10px;
    padding: var(--space-3);
    border-radius: var(--radius-sm);
    border: 1px solid var(--line);
    cursor: pointer;
    font-weight: 500;
  }
  .saved input {
    width: 18px;
    height: 18px;
    margin: 2px 0 0;
    accent-color: var(--primary);
    flex: none;
  }
  @media (max-width: 420px) {
    .codes {
      grid-template-columns: 1fr;
    }
  }
</style>
