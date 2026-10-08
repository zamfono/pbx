<!--
  Forgot password: the e-mail address, then the same confirmation whether it has an account or not
  (§5.5), so the page reveals nothing about who exists.
-->
<script lang="ts">
  import ArrowLeft from '@lucide/svelte/icons/arrow-left';
  import MailCheck from '@lucide/svelte/icons/mail-check';

  import { t } from '#lib/i18n/index.svelte.js';
  import { href } from '#lib/state/router.svelte.js';
  import Button from '#lib/ui/Button.svelte';

  const SEND_DELAY_MS = 600;
  let email = $state('');
  let busy = $state(false);
  let sent = $state(false);
</script>

<header class="head">
  <h1>{t('auth.forgot.title')}</h1>
  {#if !sent}<p class="sub">{t('auth.forgot.intro')}</p>{/if}
</header>

{#if sent}
  <div class="sent" role="status">
    <span class="icon" aria-hidden="true"><MailCheck size={26} /></span>
    <p>{t('auth.forgot.sent')}</p>
    <p class="note">{t('auth.forgot.validity')}</p>
  </div>
{:else}
  <form
    class="form"
    onsubmit={event => {
      event.preventDefault();
      busy = true;
      setTimeout(() => {
        busy = false;
        sent = true;
      }, SEND_DELAY_MS);
    }}
  >
    <label class="field">
      <span>{t('auth.login.email')}</span>
      <input
        type="email"
        bind:value={email}
        autocomplete="username"
        required
        placeholder={t('auth.login.emailPlaceholder')}
      />
    </label>
    <Button type="submit" variant="primary" size="lg" full loading={busy}
      >{t('auth.forgot.submit')}</Button
    >
  </form>
{/if}

<a class="back" href={href('/auth/signin')}
  ><ArrowLeft size={15} /> {t('auth.backToLogin')}</a
>

<style>
  .head {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .sub {
    color: var(--text-muted);
  }
  .form {
    display: flex;
    flex-direction: column;
    gap: var(--space-4);
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
    font-size: var(--text-lg);
    padding: 11px 14px;
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
  .sent {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    padding: var(--space-4);
    border-radius: var(--radius-md);
    background: var(--ok-soft);
  }
  .sent p {
    font-weight: 600;
  }
  .sent .note {
    font-weight: 400;
    font-size: var(--text-sm);
    color: var(--text-muted);
  }
  .icon {
    color: var(--ok);
  }
  .back {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    align-self: flex-start;
    font-weight: 700;
    font-size: var(--text-sm);
  }
</style>
