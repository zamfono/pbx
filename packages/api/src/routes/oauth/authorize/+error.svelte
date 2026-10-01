<script lang="ts">
  import '#app.css';

  import { resolve } from '$app/paths';
  import { page } from '$app/state';

  import { dictionaryFor } from '#lib/i18n/index.js';

  // `+error.svelte` only ever receives `error` as a prop (SvelteKit 2 + Svelte 5); the layout
  // data that survived the failed page load (`+layout.server.ts`'s `dictionary`/`companyName`)
  // comes through the page store instead. `App.PageData` declares both optional, since most
  // routes return neither, so this falls back the same way `dictionaryFor` itself does.
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
