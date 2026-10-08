<!--
  The sign-in problem page: the SSO callback's and the authorize page's refusals by `?reason=`; an
  unknown reason shows the generic message, never a raw code.
-->
<script lang="ts">
  import ArrowLeft from '@lucide/svelte/icons/arrow-left';
  import ShieldX from '@lucide/svelte/icons/shield-x';

  import { t } from '#lib/i18n/index.svelte.js';
  import { href, router } from '#lib/state/router.svelte.js';

  const REASONS = [
    'expired',
    'noUser',
    'noPassword',
    'domain',
    'unverifiedEmail',
    'issuer',
    'audience',
    'signature',
    'nonce'
  ];
  const reason = $derived(router.route.query.get('reason'));
  const message = $derived(
    reason !== null && REASONS.includes(reason)
      ? t(`auth.error.${reason}`)
      : t('auth.error.generic')
  );
</script>

<span class="icon" aria-hidden="true"><ShieldX size={26} /></span>
<header class="head">
  <h1>{t('auth.error.title')}</h1>
</header>
<p class="alert" role="alert">{message}</p>
<a class="back" href={href('/auth/signin')}
  ><ArrowLeft size={15} /> {t('auth.backToLogin')}</a
>

<style>
  .icon {
    display: grid;
    place-items: center;
    width: 52px;
    height: 52px;
    border-radius: 16px;
    background: var(--danger-soft);
    color: var(--danger);
    transform: rotate(-4deg);
  }
  .alert {
    padding: 12px 14px;
    border-radius: var(--radius-sm);
    background: var(--danger-soft);
    color: var(--danger);
    font-weight: 600;
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
