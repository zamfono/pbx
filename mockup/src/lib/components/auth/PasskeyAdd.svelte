<!--
  Setting up a passkey: its name (default "Passkey"), then the browser's prompt; `onadd` receives
  the name once the prompt succeeded.
-->
<script lang="ts">
  import FingerprintPattern from '@lucide/svelte/icons/fingerprint-pattern';

  import { store } from '#lib/api/store.svelte.js';
  import { t } from '#lib/i18n/index.svelte.js';
  import Button from '#lib/ui/Button.svelte';

  import PasskeyPrompt from './PasskeyPrompt.svelte';

  type Props = {
    account: string;
    busy?: boolean;
    variant?: 'primary' | 'secondary';
    onadd: (name: string) => void;
  };
  let { account, busy = false, variant = 'secondary', onadd }: Props = $props();

  const MAX_NAME = 100;
  let name = $state('');
  let prompting = $state(false);
  let failed = $state(false);
</script>

<form
  class="add"
  onsubmit={event => {
    event.preventDefault();
    failed = false;
    prompting = true;
  }}
>
  <label class="field">
    <span>{t('auth.passkey.name')}</span>
    <input
      bind:value={name}
      maxlength={MAX_NAME}
      placeholder={t('auth.passkey.namePlaceholder')}
      autocomplete="off"
    />
  </label>
  <Button
    type="submit"
    {variant}
    icon={FingerprintPattern}
    loading={busy}
    op="auth.passkeyAdd">{t('auth.passkey.add')}</Button
  >
  {#if failed}<p class="error" role="alert">
      {t('errors.auth.passkeyFailed')}
    </p>{/if}
</form>

<PasskeyPrompt
  open={prompting}
  mode="register"
  site={store.db.system.stack.domain}
  {account}
  onresult={ok => {
    prompting = false;
    if (ok) {
      onadd(name);
      name = '';
    } else {
      failed = true;
    }
  }}
/>

<style>
  .add {
    display: flex;
    align-items: flex-end;
    flex-wrap: wrap;
    gap: var(--space-2) var(--space-3);
  }
  .field {
    flex: 1 1 200px;
    display: flex;
    flex-direction: column;
    gap: 6px;
    font-size: var(--text-sm);
    font-weight: 700;
  }
  input {
    font-weight: 400;
    font-size: var(--text-md);
    padding: 8px 12px;
    min-height: 38px;
    border-radius: var(--radius-sm);
    border: 1px solid var(--line-strong);
    background: var(--surface);
  }
  input:focus {
    outline: none;
    border-color: var(--primary);
    box-shadow: 0 0 0 3px var(--primary-soft);
  }
  .error {
    flex-basis: 100%;
    font-size: var(--text-sm);
    font-weight: 600;
    color: var(--danger);
  }
</style>
