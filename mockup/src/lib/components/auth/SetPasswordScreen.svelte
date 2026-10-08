<!--
  Set password, the target of the setup and reset mail links: a new password of at least eight
  characters (`passwordPolicy.ts`, §5.2: no policy beyond that floor). `?expired=1` shows a link
  that expired or was already used.
-->
<script lang="ts">
  import ArrowRight from '@lucide/svelte/icons/arrow-right';
  import Check from '@lucide/svelte/icons/check';
  import CircleCheck from '@lucide/svelte/icons/circle-check';
  import Eye from '@lucide/svelte/icons/eye';
  import EyeOff from '@lucide/svelte/icons/eye-off';

  import { t } from '#lib/i18n/index.svelte.js';
  import { href, router } from '#lib/state/router.svelte.js';
  import Button from '#lib/ui/Button.svelte';

  const MIN_PASSWORD_LENGTH = 8;
  const SAVE_DELAY_MS = 600;

  let password = $state('');
  let visible = $state(false);
  let busy = $state(false);
  let done = $state(false);
  let error = $state<string | null>(null);
  const expired = $derived(router.route.query.get('expired') === '1');
  const longEnough = $derived(password.length >= MIN_PASSWORD_LENGTH);
</script>

<header class="head">
  <h1>{t('auth.setPassword.title')}</h1>
</header>

{#if expired}
  <p class="alert" role="alert">{t('auth.setPassword.invalid')}</p>
  <a class="link" href={href('/auth/forgot')}
    >{t('auth.setPassword.requestNew')}</a
  >
{:else if done}
  <div class="done" role="status">
    <CircleCheck size={26} />
    <p>{t('auth.setPassword.success')}</p>
  </div>
  <Button
    variant="primary"
    size="lg"
    full
    href={href('/auth/signin')}
    iconRight={ArrowRight}>{t('auth.setPassword.toLogin')}</Button
  >
{:else}
  <form
    class="form"
    onsubmit={event => {
      event.preventDefault();
      if (!longEnough) {
        error = t('auth.setPassword.tooShort', { min: MIN_PASSWORD_LENGTH });
        return;
      }
      error = null;
      busy = true;
      setTimeout(() => {
        busy = false;
        done = true;
      }, SAVE_DELAY_MS);
    }}
  >
    <label class="field">
      <span>{t('auth.setPassword.password')}</span>
      <span class="input">
        <input
          type={visible ? 'text' : 'password'}
          bind:value={password}
          autocomplete="new-password"
          minlength={MIN_PASSWORD_LENGTH}
          required
          aria-invalid={error !== null}
          aria-describedby="password-rule"
        />
        <button
          type="button"
          class="eye"
          aria-label={visible
            ? t('auth.setPassword.hide')
            : t('auth.setPassword.show')}
          onclick={() => (visible = !visible)}
        >
          {#if visible}<EyeOff size={18} />{:else}<Eye size={18} />{/if}
        </button>
      </span>
    </label>
    <p class="rule" class:met={longEnough} id="password-rule">
      <span class="tick" aria-hidden="true"
        ><Check size={12} strokeWidth={3} /></span
      >
      {t('auth.setPassword.rule', { min: MIN_PASSWORD_LENGTH })}
    </p>
    {#if error !== null}<p class="alert" role="alert">{error}</p>{/if}
    <p class="note">{t('auth.setPassword.note')}</p>
    <Button type="submit" variant="primary" size="lg" full loading={busy}
      >{t('auth.setPassword.submit')}</Button
    >
  </form>
{/if}

<style>
  .form {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
  }
  .field {
    display: flex;
    flex-direction: column;
    gap: 6px;
    font-size: var(--text-sm);
    font-weight: 700;
  }
  .input {
    position: relative;
    display: flex;
  }
  input {
    flex: 1;
    min-width: 0;
    font-weight: 400;
    font-size: var(--text-lg);
    padding: 11px 46px 11px 14px;
    border-radius: var(--radius-sm);
    border: 1.5px solid var(--line-strong);
    background: var(--surface-2);
  }
  input:focus {
    outline: none;
    border-color: var(--primary);
    background: var(--surface);
    box-shadow: 0 0 0 4px var(--primary-soft);
  }
  .eye {
    position: absolute;
    right: 6px;
    top: 50%;
    transform: translateY(-50%);
    display: grid;
    place-items: center;
    width: 34px;
    height: 34px;
    border: 0;
    border-radius: 50%;
    background: transparent;
    color: var(--text-muted);
    cursor: pointer;
  }
  .eye:hover {
    background: var(--surface-3);
  }
  .rule {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: var(--text-sm);
    color: var(--text-muted);
  }
  .tick {
    display: grid;
    place-items: center;
    width: 18px;
    height: 18px;
    border-radius: 50%;
    background: var(--surface-3);
    color: transparent;
    transition: background 0.2s var(--ease);
  }
  .met {
    color: var(--text);
  }
  .met .tick {
    background: var(--lime);
    color: var(--on-lime);
  }
  .note {
    font-size: var(--text-xs);
    color: var(--text-faint);
  }
  .alert {
    padding: 10px 14px;
    border-radius: var(--radius-sm);
    background: var(--danger-soft);
    color: var(--danger);
    font-weight: 600;
    font-size: var(--text-sm);
  }
  .done {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    padding: var(--space-4);
    border-radius: var(--radius-md);
    background: var(--ok-soft);
    color: var(--ok);
  }
  .done p {
    color: var(--text);
    font-weight: 600;
  }
  .link {
    font-weight: 700;
    font-size: var(--text-sm);
  }
</style>
