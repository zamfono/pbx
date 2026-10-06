<script lang="ts">
  import { tick } from 'svelte';

  import PasskeyButton from '#lib/auth/PasskeyButton.svelte';
  import RecoveryCodes from '#lib/auth/RecoveryCodes.svelte';
  import TotpSetup from '#lib/auth/TotpSetup.svelte';
  import { format, type Dictionary } from '#lib/i18n/index.js';

  import type { PageData } from './$types.js';
  import { manage, removePasskey } from './security.remote.js';

  // The signed-in user's own second factors (§5.2 "Two-factor authentication"): passkeys added
  // and removed, the authenticator app set up, replaced or removed, recovery codes regenerated.
  const {
    methods,
    dictionary,
    companyName
  }: {
    methods: NonNullable<PageData['manage']>;
    dictionary: Dictionary;
    companyName: string;
  } = $props();

  const dict = $derived(dictionary.security);
  const result = $derived(manage.result);
  const setup = $derived(result?.totpSetup ?? null);
  const busy = $derived(manage.pending > 0);
  const hasMethod = $derived(methods.totp || methods.passkeys.length > 0);
  // The calendar day of an ISO instant, as a passkey's last use is shown.
  const dayOf = (iso: string): string => iso.split('T')[0] ?? iso;

  // A new passkey's response travels in a hidden field, submitted by a hidden button.
  let passkeyResponse = $state('');
  let passkeySubmit: HTMLButtonElement | undefined = $state();
  async function submitPasskey(json: string): Promise<void> {
    passkeyResponse = json;
    await tick();
    passkeySubmit?.form?.requestSubmit(passkeySubmit);
  }
</script>

<p class="auth-note">{format(dict.signedInAs, { email: methods.email })}</p>
{#if methods.required}
  <p class="auth-note">{dict.required}</p>
{/if}
{#if result?.error}
  <p class="auth-error" role="alert">{result.error}</p>
{/if}
{#if result?.codes}
  <RecoveryCodes codes={result.codes} {companyName} dict={dictionary.mfa} />
{/if}

<h2 class="auth-subtitle">{dict.passkeys}</h2>
{#if methods.passkeys.length === 0}
  <p class="auth-note">{dict.noPasskeys}</p>
{/if}
{#each methods.passkeys as passkey (passkey.id)}
  {@const remover = removePasskey.for(passkey.id)}
  <form class="auth-actions" {...remover}>
    <span class="auth-note">
      {passkey.name} ·
      {passkey.lastUsedAt === null
        ? dict.neverUsed
        : format(dict.lastUsed, { date: dayOf(passkey.lastUsedAt) })}
    </span>
    <input {...remover.fields.id.as('hidden', passkey.id)} />
    <button class="auth-button auth-button--secondary" type="submit">
      {dict.remove}
    </button>
  </form>
  {#if remover.result?.error}
    <p class="auth-error" role="alert">{remover.result.error}</p>
  {/if}
{/each}

<form {...manage}>
  <div class="auth-field">
    <label for="passkey-name">{dictionary.mfa.passkeyName}</label>
    <input
      id="passkey-name"
      maxlength="100"
      {...manage.fields.passkeyName.as('text')}
      placeholder={dictionary.mfa.passkeyDefaultName}
    />
  </div>
  <PasskeyButton
    options={{ kind: 'register', json: methods.passkeyOptions }}
    label={dictionary.mfa.addPasskey}
    failed={dictionary.mfa.passkeyFailed}
    onresponse={submitPasskey}
  />
  <input {...manage.fields.passkey.as('hidden', passkeyResponse)} />
  <button
    hidden
    formnovalidate
    bind:this={passkeySubmit}
    {...manage.fields.action.as('submit', 'passkeyAdd')}
  ></button>

  <h2 class="auth-subtitle">{dict.totp}</h2>
  {#if setup !== null}
    <p class="auth-intro">{dictionary.mfa.enrolIntro}</p>
    <TotpSetup
      qrSvg={setup.qrSvg}
      secret={setup.secret}
      dict={dictionary.mfa}
    />
    <div class="auth-field">
      <label for="code">{dictionary.mfa.code}</label>
      <input
        id="code"
        autocomplete="one-time-code"
        required
        {...manage.fields.code.as('text')}
      />
    </div>
    <button
      class="auth-button auth-button--primary"
      disabled={busy}
      {...manage.fields.action.as('submit', 'totpConfirm')}
    >
      {dict.totpConfirm}
    </button>
  {:else}
    <p class="auth-note">{methods.totp ? dict.totpOn : dict.totpOff}</p>
    <button
      class="auth-button auth-button--secondary"
      disabled={busy}
      {...manage.fields.action.as('submit', 'totpStart')}
    >
      {methods.totp ? dict.totpReplace : dict.totpStart}
    </button>
    {#if methods.totp}
      <button
        class="auth-button auth-button--secondary"
        disabled={busy}
        {...manage.fields.action.as('submit', 'totpRemove')}
      >
        {dict.totpRemove}
      </button>
    {/if}
  {/if}

  {#if hasMethod}
    <h2 class="auth-subtitle">{dict.recoveryCodes}</h2>
    <p class="auth-note">
      {format(dict.codesLeft, { count: String(methods.recoveryCodesLeft) })}
    </p>
    <button
      class="auth-button auth-button--secondary"
      disabled={busy}
      formnovalidate
      {...manage.fields.action.as('submit', 'codes')}
    >
      {dict.regenerate}
    </button>
  {/if}
</form>
