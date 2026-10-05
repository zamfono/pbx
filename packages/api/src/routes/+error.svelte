<script lang="ts">
  import { resolve } from '$app/paths';
  import { page } from '$app/state';

  import { dictionaryFor } from '#lib/i18n/index.js';

  // The error boundary of every page, in the tenant's language rather than SvelteKit's bare
  // fallback, worded for the route it failed on: the authentication pages (§5.2) report a sign-in
  // problem, such as the forgot-password form's 404 without a relay or 429 past the §5.5 address
  // limit; the upload page (§10.5) a failed upload, such as a file past the size limit; any other URL a page that cannot be shown.
  // `+error.svelte` receives no `data` prop; `+layout.server.ts`'s `dictionary`/`companyName` come
  // through the page state, optional there since most routes return neither.
  const dictionary = $derived(page.data.dictionary ?? dictionaryFor('en'));
  const companyName = $derived(page.data.companyName ?? '');
  const routeId = $derived(page.route.id ?? '');
  const signIn = $derived(
    routeId.startsWith('/auth/') || routeId.startsWith('/oauth/')
  );
  const shown = $derived.by(() => {
    if (signIn) {
      return { title: dictionary.error.title, text: dictionary.error.generic };
    }
    if (routeId.startsWith('/upload/')) {
      return { title: dictionary.upload.title, text: dictionary.upload.error };
    }
    return {
      title: dictionary.error.unavailableTitle,
      text: dictionary.error.unavailable
    };
  });
</script>

<svelte:head>
  <title>{companyName} · {shown.title}</title>
</svelte:head>

<div class="auth-card">
  <h1 class="auth-title">{shown.title}</h1>
  <p class="auth-error">{shown.text}</p>
  {#if signIn}
    <a class="auth-link" href={resolve('/oauth/authorize')}
      >{dictionary.error.backToLogin}</a
    >
  {/if}
</div>
