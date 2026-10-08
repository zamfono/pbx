<!--
  The sign-in pages, shown while signed out and on every `/auth/…` route: sign-in with its second
  step and enrolment (`/auth/signin`, the default), forgot password, set password, the MCP
  client's consent, the problem page and the post-sign-in landing. `/auth/security` opens the
  security tab of the person's own settings.
-->
<script lang="ts">
  import { store } from '#lib/api/store.svelte.js';
  import AuthLayout from '#lib/components/auth/AuthLayout.svelte';
  import ConsentScreen from '#lib/components/auth/ConsentScreen.svelte';
  import DoneScreen from '#lib/components/auth/DoneScreen.svelte';
  import ErrorScreen from '#lib/components/auth/ErrorScreen.svelte';
  import ForgotScreen from '#lib/components/auth/ForgotScreen.svelte';
  import SetPasswordScreen from '#lib/components/auth/SetPasswordScreen.svelte';
  import SignInFlow from '#lib/components/auth/SignInFlow.svelte';
  import { t } from '#lib/i18n/index.svelte.js';
  import { go, router } from '#lib/state/router.svelte.js';
  import { session } from '#lib/state/session.svelte.js';

  const path = $derived(router.route.path);
  const TITLES: Record<string, string> = {
    '/auth/forgot': 'auth.forgot.title',
    '/auth/set-password': 'auth.setPassword.title',
    '/auth/consent': 'auth.consent.pageTitle',
    '/auth/error': 'auth.error.title',
    '/auth/done': 'auth.done.title'
  };

  $effect(() => {
    if (path === '/auth/security') {
      go(session.signedIn ? '/me/security' : '/auth/signin');
    }
  });

  $effect(() => {
    document.title = `${t(TITLES[path] ?? 'auth.login.title')} · ${store.db.settings.companyName}`;
  });
</script>

{#if path === '/auth/forgot'}
  <AuthLayout><ForgotScreen /></AuthLayout>
{:else if path === '/auth/set-password'}
  <AuthLayout><SetPasswordScreen /></AuthLayout>
{:else if path === '/auth/consent'}
  <AuthLayout><ConsentScreen /></AuthLayout>
{:else if path === '/auth/error'}
  <AuthLayout><ErrorScreen /></AuthLayout>
{:else if path === '/auth/done'}
  <AuthLayout><DoneScreen /></AuthLayout>
{:else}
  <SignInFlow />
{/if}
