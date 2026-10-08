<!--
  The second step of a password sign-in (§5.2 "Two-factor authentication"): a code from the
  authenticator app, a passkey through the browser's prompt, or one of the recovery codes, which is
  used up. Runs `auth.secondFactor` as the person signing in.
-->
<script lang="ts">
  import FingerprintPattern from '@lucide/svelte/icons/fingerprint-pattern';
  import LifeBuoy from '@lucide/svelte/icons/life-buoy';
  import Smartphone from '@lucide/svelte/icons/smartphone';
  import type { Component } from 'svelte';

  import { store } from '#lib/api/store.svelte.js';
  import type { User } from '#lib/api/types.js';
  import { t } from '#lib/i18n/index.svelte.js';
  import Button from '#lib/ui/Button.svelte';

  import { callAs } from './mfa';
  import OtpInput from './OtpInput.svelte';
  import PasskeyPrompt from './PasskeyPrompt.svelte';

  type Method = 'totp' | 'passkey' | 'recovery';
  type Props = {
    user: User;
    /** The authenticator code, bindable so the demo authenticator can fill it in. */
    code: string;
    onverified: () => void;
  };
  let { user, code = $bindable(), onverified }: Props = $props();

  const site = $derived(store.db.system.stack.domain);
  const methods = $derived(
    (
      [
        { id: 'totp', icon: Smartphone, available: user.mfa.totp },
        {
          id: 'passkey',
          icon: FingerprintPattern,
          available: user.mfa.passkeys > 0
        },
        {
          id: 'recovery',
          icon: LifeBuoy,
          available: user.mfa.recoveryCodesLeft > 0
        }
      ] satisfies { id: Method; icon: Component; available: boolean }[]
    ).filter(method => method.available)
  );
  let chosen = $state<Method | null>(null);
  const method = $derived(chosen ?? methods[0]?.id ?? 'recovery');
  let recovery = $state('');
  let error = $state<string | null>(null);
  let busy = $state(false);
  let prompting = $state(false);

  const VERIFY_DELAY_MS = 450;

  function verify(input: { method: Method; code?: string }): void {
    error = null;
    busy = true;
    setTimeout(() => {
      busy = false;
      const result = callAs(user, 'auth.secondFactor', {
        userId: user.id,
        ...input
      });
      if (result.ok) {
        onverified();
      } else {
        error = t(`errors.${result.error.code}`);
        if (input.method === 'totp') {
          code = '';
        }
      }
    }, VERIFY_DELAY_MS);
  }

  function choose(next: Method): void {
    chosen = next;
    error = null;
  }
</script>

<div class="step">
  {#if methods.length > 1}
    <div class="methods" role="tablist" aria-label={t('auth.verify.methods')}>
      {#each methods as option (option.id)}
        <button
          type="button"
          role="tab"
          aria-selected={method === option.id}
          class:on={method === option.id}
          onclick={() => choose(option.id)}
        >
          <option.icon size={16} />
          <span>{t(`auth.verify.method.${option.id}`)}</span>
        </button>
      {/each}
    </div>
  {/if}

  {#if method === 'totp'}
    <form
      class="pane"
      onsubmit={event => {
        event.preventDefault();
        verify({ method: 'totp', code });
      }}
    >
      <p class="intro">{t('auth.verify.totpIntro')}</p>
      <OtpInput
        bind:value={code}
        label={t('auth.verify.codeLabel')}
        invalid={error !== null}
        disabled={busy}
        autofocus
        oncomplete={value => verify({ method: 'totp', code: value })}
      />
      {#if error !== null}<p class="error" role="alert">{error}</p>{/if}
      <p class="demo-hint">{t('auth.verify.demoHint')}</p>
      <Button
        type="submit"
        variant="primary"
        size="lg"
        full
        loading={busy}
        disabled={code.length !== 6}
        op="auth.secondFactor">{t('auth.verify.submit')}</Button
      >
    </form>
  {:else if method === 'passkey'}
    <div class="pane passkey">
      <div class="passkey-art" aria-hidden="true">
        <FingerprintPattern size={40} strokeWidth={1.6} />
      </div>
      <p class="intro">{t('auth.verify.passkeyIntro')}</p>
      {#if error !== null}<p class="error" role="alert">{error}</p>{/if}
      <Button
        variant="primary"
        size="lg"
        full
        icon={FingerprintPattern}
        loading={busy}
        op="auth.secondFactor"
        onclick={() => (prompting = true)}>{t('auth.verify.usePasskey')}</Button
      >
    </div>
  {:else}
    <form
      class="pane"
      onsubmit={event => {
        event.preventDefault();
        verify({ method: 'recovery', code: recovery });
      }}
    >
      <p class="intro">
        {t('auth.verify.recoveryIntro', { count: user.mfa.recoveryCodesLeft })}
      </p>
      <label class="field">
        <span>{t('auth.verify.recoveryLabel')}</span>
        <input
          class="recovery"
          bind:value={recovery}
          autocomplete="off"
          spellcheck="false"
          placeholder="ABCD-EFGH-IJKL-MNOP"
          aria-invalid={error !== null}
        />
      </label>
      {#if error !== null}<p class="error" role="alert">{error}</p>{/if}
      <p class="demo-hint">{t('auth.verify.recoveryDemoHint')}</p>
      <Button
        type="submit"
        variant="primary"
        size="lg"
        full
        loading={busy}
        disabled={recovery.trim() === ''}
        op="auth.secondFactor">{t('auth.verify.submit')}</Button
      >
    </form>
  {/if}
</div>

<PasskeyPrompt
  open={prompting}
  mode="authenticate"
  {site}
  account={user.email ?? user.name}
  onresult={ok => {
    prompting = false;
    if (ok) {
      verify({ method: 'passkey' });
    } else {
      error = t('errors.auth.passkeyFailed');
    }
  }}
/>

<style>
  .step {
    display: flex;
    flex-direction: column;
    gap: var(--space-4);
  }
  .methods {
    display: grid;
    grid-auto-flow: column;
    grid-auto-columns: 1fr;
    gap: 4px;
    padding: 4px;
    border-radius: var(--radius-md);
    background: var(--surface-3);
  }
  .methods button {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 4px;
    padding: 8px 6px;
    border: 0;
    border-radius: var(--radius-sm);
    background: transparent;
    color: var(--text-muted);
    font-size: var(--text-xs);
    font-weight: 700;
    cursor: pointer;
    text-align: center;
    line-height: 1.2;
    transition:
      background 0.15s var(--ease),
      color 0.15s var(--ease);
  }
  .methods button:hover {
    color: var(--text);
  }
  .methods button.on {
    background: var(--surface);
    color: var(--primary);
    box-shadow: var(--shadow-sm);
  }
  .pane {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
  }
  .passkey {
    align-items: center;
    text-align: center;
  }
  .passkey-art {
    display: grid;
    place-items: center;
    width: 76px;
    height: 76px;
    border-radius: 24px;
    color: var(--primary);
    background: var(--primary-soft);
    transform: rotate(-4deg);
  }
  .intro {
    color: var(--text-muted);
  }
  .field {
    display: flex;
    flex-direction: column;
    gap: 6px;
    font-size: var(--text-sm);
    font-weight: 700;
  }
  .recovery {
    font-family: var(--font-mono);
    font-size: var(--text-lg);
    letter-spacing: 0.06em;
    text-transform: uppercase;
    padding: 10px 12px;
    border-radius: var(--radius-sm);
    border: 1.5px solid var(--line-strong);
    background: var(--surface-2);
    width: 100%;
  }
  .recovery:focus {
    outline: none;
    border-color: var(--primary);
    box-shadow: 0 0 0 3px var(--primary-soft);
  }
  .recovery[aria-invalid='true'] {
    border-color: var(--danger);
  }
  .error {
    font-size: var(--text-sm);
    font-weight: 600;
    color: var(--danger);
  }
  .demo-hint {
    font-size: var(--text-xs);
    color: var(--text-faint);
  }
</style>
