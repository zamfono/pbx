<script lang="ts">
  import type { PageData } from './$types.js';
  import Manage from './Manage.svelte';
  import SignIn from './SignIn.svelte';

  // §5.2 "Authentication pages": the security page, opened only by a fresh sign-in on it.
  const { data }: { data: PageData } = $props();

  const dict = $derived(data.dictionary.security);
</script>

<svelte:head>
  <title>{data.companyName} · {dict.title}</title>
</svelte:head>

<div class="auth-card">
  <h1 class="auth-title">{dict.title}</h1>
  {#if data.manage === null}
    <SignIn
      dictionary={data.dictionary}
      companyName={data.companyName}
      sso={data.sso}
    />
  {:else}
    <Manage
      methods={data.manage}
      dictionary={data.dictionary}
      companyName={data.companyName}
    />
  {/if}
</div>
