<script lang="ts">
  import '#app.css';

  import { resolve } from '$app/paths';
  import { page } from '$app/state';

  import { dictionaryFor } from '$lib/i18n/index.js';

  // The error boundary of the `/auth/*` pages (§5.2 "Authentication pages"): the forgot-password
  // form's 404 without a relay and 429 past the §5.5 address limit, among others, render here in
  // the tenant's language rather than as SvelteKit's bare fallback. `+error.svelte` receives no
  // `data` prop; `+layout.server.ts`'s `dictionary`/`companyName` come through the page state,
  // optional there since most routes return neither.
  const dict = $derived((page.data.dictionary ?? dictionaryFor('en')).error);
  const companyName = $derived(page.data.companyName ?? '');
</script>

<svelte:head>
  <title>{companyName} · {dict.title}</title>
</svelte:head>

<div class="auth-card">
  <h1 class="auth-title">{dict.title}</h1>
  <p class="auth-error">{dict.generic}</p>
  <a class="auth-link" href={resolve('/oauth/authorize')}>{dict.backToLogin}</a>
</div>
