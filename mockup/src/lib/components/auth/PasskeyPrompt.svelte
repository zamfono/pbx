<!--
  The browser's own passkey prompt, simulated: the site, the account, the fingerprint scan, then a
  tick. Neutral styling, since it belongs to the browser, not to the page. `onresult(false)` when
  the person cancels.
-->
<script lang="ts">
  import Check from '@lucide/svelte/icons/check';
  import FingerprintPattern from '@lucide/svelte/icons/fingerprint-pattern';
  import KeyRound from '@lucide/svelte/icons/key-round';

  import { t } from '#lib/i18n/index.svelte.js';

  type Props = {
    open: boolean;
    mode: 'authenticate' | 'register';
    site: string;
    account: string;
    onresult: (ok: boolean) => void;
  };
  let { open, mode, site, account, onresult }: Props = $props();

  const SCAN_MS = 1700;
  const DONE_MS = 650;
  let element = $state<HTMLDialogElement>();
  let phase = $state<'scan' | 'done'>('scan');

  $effect(() => {
    if (element === undefined) {
      return;
    }
    if (open && !element.open) {
      phase = 'scan';
      element.showModal();
    } else if (!open && element.open) {
      element.close();
    }
  });

  $effect(() => {
    if (!open) {
      return;
    }
    let finish: ReturnType<typeof setTimeout> | undefined;
    const scan = setTimeout(() => {
      phase = 'done';
      finish = setTimeout(() => onresult(true), DONE_MS);
    }, SCAN_MS);
    return () => {
      clearTimeout(scan);
      clearTimeout(finish);
    };
  });
</script>

<dialog
  bind:this={element}
  aria-label={mode === 'register'
    ? t('auth.passkey.promptCreate')
    : t('auth.passkey.promptSignIn')}
  oncancel={event => {
    event.preventDefault();
    onresult(false);
  }}
>
  {#if open}
    <div class="sheet">
      <div class="site">
        <KeyRound size={14} />
        <span class="truncate">{site}</span>
      </div>
      <h2>
        {mode === 'register'
          ? t('auth.passkey.promptCreate')
          : t('auth.passkey.promptSignIn')}
      </h2>
      <p class="account truncate">{account}</p>
      <div class="sensor" class:done={phase === 'done'} aria-live="polite">
        {#if phase === 'done'}
          <Check size={40} strokeWidth={2.5} />
          <span class="sr-only">{t('auth.passkey.promptDone')}</span>
        {:else}
          <FingerprintPattern size={44} strokeWidth={1.6} />
        {/if}
      </div>
      <p class="hint">
        {phase === 'done'
          ? t('auth.passkey.promptDone')
          : t('auth.passkey.promptHint')}
      </p>
      <button
        type="button"
        class="cancel"
        disabled={phase === 'done'}
        onclick={() => onresult(false)}>{t('common.cancel')}</button
      >
    </div>
  {/if}
</dialog>

<style>
  dialog {
    border: 0;
    padding: 0;
    background: transparent;
    max-width: calc(100vw - 32px);
  }
  dialog::backdrop {
    background: var(--overlay);
    backdrop-filter: blur(3px);
  }
  .sheet {
    width: 320px;
    max-width: 100%;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: var(--space-2);
    padding: var(--space-5) var(--space-5) var(--space-4);
    border-radius: 18px;
    background: var(--surface);
    color: var(--text);
    box-shadow: var(--shadow-lg);
    font-family:
      ui-sans-serif,
      system-ui,
      -apple-system,
      'Segoe UI',
      sans-serif;
    text-align: center;
    animation: rise 0.22s var(--ease);
  }
  .site {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    max-width: 100%;
    font-size: var(--text-xs);
    color: var(--text-muted);
    background: var(--surface-3);
    padding: 3px 10px;
    border-radius: var(--radius-pill);
  }
  h2 {
    font-family: inherit;
    font-size: var(--text-lg);
    font-weight: 700;
    letter-spacing: 0;
    margin-top: var(--space-2);
  }
  .account {
    max-width: 100%;
    font-size: var(--text-sm);
    color: var(--text-muted);
  }
  .sensor {
    position: relative;
    display: grid;
    place-items: center;
    width: 84px;
    height: 84px;
    margin: var(--space-3) 0 var(--space-1);
    border-radius: 50%;
    color: var(--info);
    background: var(--info-soft);
  }
  .sensor::after {
    content: '';
    position: absolute;
    inset: -6px;
    border-radius: 50%;
    border: 2px solid var(--info);
    opacity: 0;
    animation: pulse 1.2s var(--ease) infinite;
  }
  .sensor.done {
    color: var(--ok);
    background: var(--ok-soft);
  }
  .sensor.done::after {
    animation: none;
  }
  .hint {
    font-size: var(--text-sm);
    color: var(--text-muted);
    min-height: 2.6em;
  }
  .cancel {
    margin-top: var(--space-2);
    width: 100%;
    border: 1px solid var(--line-strong);
    background: var(--surface-2);
    border-radius: 10px;
    padding: 8px;
    font-weight: 600;
    cursor: pointer;
  }
  .cancel:disabled {
    opacity: 0.5;
    cursor: default;
  }
  @keyframes pulse {
    0% {
      transform: scale(0.9);
      opacity: 0.7;
    }
    100% {
      transform: scale(1.25);
      opacity: 0;
    }
  }
  @keyframes rise {
    from {
      transform: translateY(8px) scale(0.98);
      opacity: 0;
    }
  }
</style>
