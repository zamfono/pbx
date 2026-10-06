<script lang="ts">
  import { secondFactor } from '#lib/auth/secondFactor.remote.js';
  import SecondFactor from '#lib/auth/SecondFactor.svelte';
  import type { Dictionary } from '#lib/i18n/index.js';

  import { signIn } from './security.remote.js';

  // The fresh sign-in that opens the security page (§5.2 "Authentication pages"): e-mail and
  // password, then the second step where the user has a second factor, or SSO.
  const {
    dictionary,
    companyName,
    sso
  }: {
    dictionary: Dictionary;
    companyName: string;
    sso: { label: string } | null;
  } = $props();

  const dict = $derived(dictionary.login);
  // The second step's form is only ever submitted after this one, so its result, once there, is
  // the latest outcome.
  const result = $derived(secondFactor.result ?? signIn.result);
  const step = $derived(result && 'step' in result ? result : null);
  const refusal = $derived(result && 'message' in result ? result : null);
  const busy = $derived(signIn.pending > 0);
  // eslint-disable-next-line no-underscore-dangle -- the prefix keeps the password out of a re-rendered page
  const passwordField = $derived(signIn.fields._password);
</script>

{#if step !== null}
  <SecondFactor {step} {companyName} dict={dictionary.mfa} />
{:else}
  <p class="auth-intro">{dictionary.security.signInIntro}</p>
  {#if refusal !== null}
    <p class="auth-error" id="refusal" role="alert">{refusal.message}</p>
  {/if}
  <form {...signIn}>
    <div class="auth-field">
      <label for="email">{dict.email}</label>
      <input
        id="email"
        autocomplete="username"
        required
        {...signIn.fields.email.as('email', refusal?.email ?? '')}
        aria-invalid={refusal === null ? undefined : 'true'}
        aria-describedby={refusal === null ? undefined : 'refusal'}
      />
    </div>
    <div class="auth-field">
      <label for="password">{dict.password}</label>
      <input
        id="password"
        autocomplete="current-password"
        required
        {...passwordField.as('password')}
        aria-invalid={refusal === null ? undefined : 'true'}
        aria-describedby={refusal === null ? undefined : 'refusal'}
      />
    </div>
    <button
      class="auth-button auth-button--primary"
      disabled={busy}
      {...signIn.fields.action.as('submit', 'password')}
    >
      {dict.submit}
    </button>
    {#if sso !== null}
      <button
        class="auth-button auth-button--secondary"
        disabled={busy}
        formnovalidate
        {...signIn.fields.action.as('submit', 'sso')}
      >
        {dict.ssoPrefix}{sso.label}
      </button>
    {/if}
  </form>
{/if}
