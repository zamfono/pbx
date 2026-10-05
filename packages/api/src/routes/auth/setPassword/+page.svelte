<script lang="ts">
  import { resolve } from '$app/paths';

  import { MIN_PASSWORD_LENGTH } from '#lib/auth/passwordPolicy.js';

  import type { PageData } from './$types.js';
  import { setPassword } from './setPassword.remote.js';

  const { data }: { data: PageData } = $props();

  const dict = $derived(data.dictionary.setPassword);
  const refusal = $derived(setPassword.result ?? null);
  const busy = $derived(setPassword.pending > 0);
  // The underscored field name keeps the password out of the re-rendered page: SvelteKit
  // repopulates a non-enhanced submission's fields from the submitted values, and skips the
  // underscored ones (§5.2).
  // eslint-disable-next-line no-underscore-dangle -- that prefix is what carries the rule above
  const passwordField = $derived(setPassword.fields._password);
</script>

<svelte:head>
  <title>{data.companyName} · {dict.title}</title>
</svelte:head>

<div class="auth-card">
  <h1 class="auth-title">{dict.title}</h1>
  {#if data.done}
    <p class="auth-note" role="status">{dict.success}</p>
    <a class="auth-link" href={resolve('/oauth/authorize')}
      >{dict.successLoginLink}</a
    >
  {:else}
    {#if refusal !== null}
      <p class="auth-error" id="refusal" role="alert">{refusal.message}</p>
    {/if}
    <form {...setPassword}>
      <input {...setPassword.fields.token.as('hidden', data.token ?? '')} />
      <div class="auth-field">
        <label for="password">{dict.password}</label>
        <input
          id="password"
          autocomplete="new-password"
          minlength={MIN_PASSWORD_LENGTH}
          required
          {...passwordField.as('password')}
          aria-invalid={refusal === null ? undefined : 'true'}
          aria-describedby={refusal === null ? undefined : 'refusal'}
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
</div>
