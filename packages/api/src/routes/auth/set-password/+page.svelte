<script lang="ts">
  import '#app.css';

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
  // A submission without JavaScript posts to the form's `?/remote=…` action, which replaces this
  // page's query string; carrying the token in it as well lets the re-rendered page's `load` find
  // the link it is answering, so a refusal shows the form again rather than the expired-link page.
  const action = $derived(
    data.token === null
      ? setPassword.action
      : `?token=${encodeURIComponent(data.token)}&${setPassword.action.slice(1)}`
  );
</script>

<svelte:head>
  <title>{data.companyName} · {dict.title}</title>
</svelte:head>

<div class="auth-card">
  <h1 class="auth-title">{dict.title}</h1>
  {#if data.done}
    <p class="auth-note">{dict.success}</p>
    <a class="auth-link" href={resolve('/oauth/authorize')}
      >{dict.successLoginLink}</a
    >
  {:else}
    {#if refusal !== null}
      <p class="auth-error">{refusal.message}</p>
    {/if}
    <form {...setPassword} {action}>
      <input {...setPassword.fields.token.as('hidden', data.token ?? '')} />
      <div class="auth-field">
        <label for="password">{dict.password}</label>
        <input
          id="password"
          autocomplete="new-password"
          minlength={MIN_PASSWORD_LENGTH}
          required
          {...passwordField.as('password')}
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
