<script lang="ts">
  import { resolve } from '$app/paths';

  import type { PageData } from './$types.js';
  import { requestReset } from './forgot.remote.js';

  const { data }: { data: PageData } = $props();

  const dict = $derived(data.dictionary.forgot);
  // §5.2/§10.2: the confirmation is the same whether the address has an account or not, since
  // the form answers every accepted request alike.
  const sent = $derived(requestReset.result?.sent === true);
  const busy = $derived(requestReset.pending > 0);
</script>

<svelte:head>
  <title>{data.companyName} · {dict.title}</title>
</svelte:head>

<div class="auth-card">
  <h1 class="auth-title">{dict.title}</h1>
  {#if sent}
    <p class="auth-note">{dict.sent}</p>
  {:else}
    <p class="auth-intro">{dict.intro}</p>
    <form {...requestReset}>
      <div class="auth-field">
        <label for="email">{dict.email}</label>
        <input
          id="email"
          autocomplete="username"
          required
          {...requestReset.fields.email.as('email')}
        />
      </div>
      <button
        class="auth-button auth-button--primary"
        type="submit"
        disabled={busy}
      >
        {dict.submit}
      </button>
    </form>
  {/if}
  <a class="auth-link" href={resolve('/oauth/authorize')}>{dict.backToLogin}</a>
</div>
