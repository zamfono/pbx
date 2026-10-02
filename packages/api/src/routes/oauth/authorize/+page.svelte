<script lang="ts">
  import { resolve } from '$app/paths';

  import { format } from '#lib/i18n/index.js';

  import type { PageData } from './$types.js';
  import { consent as consentForm, login } from './authorize.remote.js';

  const { data }: { data: PageData } = $props();

  const dict = $derived(data.dictionary.login);
  const result = $derived(login.result);
  // §5.2 "Authentication pages": a consent step naming the requesting client, rendered only once
  // the person has actually authenticated — by password, the login form's own result carries it
  // (`loginSubmit` returns this instead of redirecting whenever the outer request named a
  // client); by SSO, the callback seals the same `zamfono_consent` cookie and `load`'s
  // `data.consent` carries it instead, since that path returns here on a fresh GET.
  const consent = $derived(
    data.consent ?? (result && 'needsConsent' in result ? result : null)
  );
  const refusal = $derived(result && 'message' in result ? result : null);
  const consentText = $derived(
    data.clientName === null
      ? null
      : format(dict.consentIntro, { client: data.clientName })
  );
  const busy = $derived(login.pending > 0);
  // The underscored field name keeps the password out of the re-rendered page: SvelteKit
  // repopulates a non-enhanced submission's fields from the submitted values, and skips the
  // underscored ones (§5.2).
  // eslint-disable-next-line no-underscore-dangle -- that prefix is what carries the rule above
  const passwordField = $derived(login.fields._password);
</script>

<svelte:head>
  <title>{data.companyName} · {dict.title}</title>
</svelte:head>

<div class="auth-card">
  <h1 class="auth-title">{dict.title}</h1>
  {#if consent !== null}
    <p class="auth-intro">
      {format(dict.consentIntro, { client: consent.clientName })}
    </p>
    <p class="auth-note">{consent.redirectUri}</p>
    <form {...consentForm}>
      <button
        class="auth-button auth-button--primary"
        {...consentForm.fields.action.as('submit', 'approve')}
      >
        {dict.consentApprove}
      </button>
      <button
        class="auth-button auth-button--secondary"
        {...consentForm.fields.action.as('submit', 'deny')}
      >
        {dict.consentDeny}
      </button>
    </form>
  {:else}
    {#if consentText !== null}
      <p class="auth-intro">{consentText}</p>
    {/if}
    {#if refusal !== null}
      <p class="auth-error">{refusal.message}</p>
    {/if}
    <form {...login}>
      {#if data.authorize !== null}
        <input
          {...login.fields.client_id.as('hidden', data.authorize.clientId)}
        />
        <!-- A request that sent no `redirect_uri` resumes without one, so the code it gets
             stays redeemable without one too (OAuth 2.1 §2.3.2). -->
        {#if data.authorize.redirectUriDefaulted !== true}
          <input
            {...login.fields.redirect_uri.as(
              'hidden',
              data.authorize.redirectUri
            )}
          />
        {/if}
        {#if data.authorize.state !== null}
          <input {...login.fields.state.as('hidden', data.authorize.state)} />
        {/if}
        <input
          {...login.fields.code_challenge.as(
            'hidden',
            data.authorize.codeChallenge
          )}
        />
        <input {...login.fields.scope.as('hidden', data.authorize.scope)} />
      {/if}
      <div class="auth-field">
        <label for="email">{dict.email}</label>
        <input
          id="email"
          autocomplete="username"
          required
          {...login.fields.email.as('email', refusal?.email ?? '')}
        />
      </div>
      <div class="auth-field">
        <label for="password">{dict.password}</label>
        <input
          id="password"
          autocomplete="current-password"
          required
          {...passwordField.as('password')}
        />
      </div>
      <button
        class="auth-button auth-button--primary"
        disabled={busy}
        {...login.fields.action.as('submit', 'password')}
      >
        {dict.submit}
      </button>
      {#if data.sso !== null}
        <!-- `formnovalidate`: the identity provider authenticates this person, so the e-mail and
             password fields stay empty on this path and their `required` must not block it. -->
        <button
          class="auth-button auth-button--secondary"
          disabled={busy}
          formnovalidate
          {...login.fields.action.as('submit', 'sso')}
        >
          {dict.ssoPrefix}{data.sso.label}
        </button>
      {/if}
    </form>
    {#if data.mailConfigured}
      <a class="auth-link" href={resolve('/auth/forgot')}>{dict.forgotLink}</a>
    {/if}
  {/if}
</div>
