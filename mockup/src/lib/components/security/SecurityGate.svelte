<!--
  The fresh sign-in that opens the security page (§5.2): e-mail and password, then the second step
  where the person has a second factor — or SSO. Demo: any password for the person's own address.
-->
<script lang="ts">
  import ArrowLeft from '@lucide/svelte/icons/arrow-left';
  import Building from '@lucide/svelte/icons/building';
  import LockKeyhole from '@lucide/svelte/icons/lock-keyhole';

  import { hasMfa } from '#lib/api/ops/areas/auth.js';
  import { store } from '#lib/api/store.svelte.js';
  import type { User } from '#lib/api/types.js';
  import DemoAuthenticator from '#lib/components/auth/DemoAuthenticator.svelte';
  import { existingSecret, ssoName } from '#lib/components/auth/mfa.js';
  import SecondFactorStep from '#lib/components/auth/SecondFactorStep.svelte';
  import { t } from '#lib/i18n/index.svelte.js';
  import Button from '#lib/ui/Button.svelte';

  let { user, onopen }: { user: User; onopen: () => void } = $props();

  const CHECK_DELAY_MS = 450;
  const SSO_DELAY_MS = 900;

  const sso = $derived(ssoName(store.db.settings));
  // The person's own address, prefilled once; they may still change it.
  // svelte-ignore state_referenced_locally
  let email = $state(user.email ?? '');
  let password = $state('');
  let error = $state<string | null>(null);
  let busy = $state(false);
  let ssoBusy = $state(false);
  let step = $state<'credentials' | 'verify'>('credentials');
  let code = $state('');

  function submit(): void {
    error = null;
    busy = true;
    setTimeout(() => {
      busy = false;
      if (
        email.trim().toLowerCase() !== (user.email ?? '').toLowerCase() ||
        password === ''
      ) {
        error = t('auth.login.invalid');
        return;
      }
      if (hasMfa(user)) {
        step = 'verify';
      } else {
        onopen();
      }
    }, CHECK_DELAY_MS);
  }

  function viaSso(): void {
    ssoBusy = true;
    setTimeout(() => {
      ssoBusy = false;
      onopen();
    }, SSO_DELAY_MS);
  }
</script>

<section class="gate">
  <div class="intro">
    <span class="lock" aria-hidden="true"><LockKeyhole size={24} /></span>
    <div>
      <h3>{t('security.gate.title')}</h3>
      <p>{t('security.gate.intro')}</p>
    </div>
  </div>

  {#if step === 'credentials'}
    {#if error !== null}<p class="alert" role="alert">{error}</p>{/if}
    <form
      class="form"
      onsubmit={event => {
        event.preventDefault();
        submit();
      }}
    >
      <label class="field">
        <span>{t('auth.login.email')}</span>
        <input
          type="email"
          bind:value={email}
          autocomplete="username"
          required
          aria-invalid={error !== null}
        />
      </label>
      <label class="field">
        <span>{t('auth.login.password')}</span>
        <input
          type="password"
          bind:value={password}
          autocomplete="current-password"
          required
          aria-invalid={error !== null}
        />
      </label>
      <p class="hint">{t('security.gate.demoHint')}</p>
      <div class="buttons">
        <Button type="submit" variant="primary" loading={busy}
          >{t('auth.login.submit')}</Button
        >
        {#if sso !== null}
          <Button icon={Building} loading={ssoBusy} onclick={viaSso}
            >{t('auth.login.sso', { provider: sso })}</Button
          >
        {/if}
      </div>
    </form>
  {:else}
    <div class="verify">
      <div class="verify-main">
        <SecondFactorStep {user} bind:code onverified={onopen} />
        <button
          type="button"
          class="back"
          onclick={() => (step = 'credentials')}
          ><ArrowLeft size={14} /> {t('common.back')}</button
        >
      </div>
      {#if user.mfa.totp}
        <div class="demo">
          <DemoAuthenticator
            secret={existingSecret(user.id)}
            issuer={store.db.settings.companyName}
            account={user.email ?? ''}
            onuse={value => (code = value)}
          />
        </div>
      {/if}
    </div>
  {/if}
</section>

<style>
  .gate {
    display: flex;
    flex-direction: column;
    gap: var(--space-4);
    padding: var(--space-5);
    border-radius: var(--radius-md);
    background: var(--surface);
    border: 1px solid var(--line);
    box-shadow: var(--shadow-sm);
    max-width: 760px;
  }
  .intro {
    display: flex;
    gap: var(--space-4);
    align-items: flex-start;
  }
  .intro p {
    color: var(--text-muted);
    margin-top: 4px;
  }
  .lock {
    display: grid;
    place-items: center;
    width: 48px;
    height: 48px;
    flex: none;
    border-radius: 15px;
    background: var(--lime);
    color: var(--on-lime);
    transform: rotate(-4deg);
  }
  .alert {
    padding: 10px 14px;
    border-radius: var(--radius-sm);
    background: var(--danger-soft);
    color: var(--danger);
    font-weight: 600;
    font-size: var(--text-sm);
  }
  .form {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
    max-width: 400px;
  }
  .field {
    display: flex;
    flex-direction: column;
    gap: 6px;
    font-size: var(--text-sm);
    font-weight: 700;
  }
  input {
    font-weight: 400;
    font-size: var(--text-md);
    padding: 9px 12px;
    border-radius: var(--radius-sm);
    border: 1px solid var(--line-strong);
    background: var(--surface);
  }
  input:focus {
    outline: none;
    border-color: var(--primary);
    box-shadow: 0 0 0 3px var(--primary-soft);
  }
  .hint {
    font-size: var(--text-xs);
    color: var(--text-faint);
  }
  .buttons {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2);
  }
  .verify {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-5);
    align-items: flex-start;
  }
  .verify-main {
    flex: 1 1 320px;
    max-width: 420px;
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
  }
  .demo {
    flex: 0 1 260px;
  }
  .back {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    align-self: flex-start;
    border: 0;
    background: transparent;
    color: var(--primary);
    font-weight: 700;
    font-size: var(--text-sm);
    cursor: pointer;
    padding: 0;
  }
</style>
