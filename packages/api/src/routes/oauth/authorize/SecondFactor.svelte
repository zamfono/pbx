<script lang="ts">
  import { tick } from 'svelte';

  import PasskeyButton from '#lib/auth/PasskeyButton.svelte';
  import RecoveryCodes from '#lib/auth/RecoveryCodes.svelte';
  import TotpSetup from '#lib/auth/TotpSetup.svelte';
  import type { Dictionary } from '#lib/i18n/index.js';

  import { secondFactor } from './authorize.remote.js';
  import type { SecondFactorStep } from './secondFactorSubmit.js';

  // The second step of a password sign-in (§5.2 "Two-factor authentication"): a code or a
  // passkey, the enrolment of an authenticator app or a passkey, or the recovery codes that
  // enrolment issued.
  const {
    step,
    companyName,
    dict
  }: {
    step: SecondFactorStep;
    companyName: string;
    dict: Dictionary['mfa'];
  } = $props();

  const refusal = $derived('error' in step ? step.error : null);
  // The verify step's passkey options, while the user has a passkey.
  const request = $derived(step.step === 'verify' ? step.passkey : null);
  const busy = $derived(secondFactor.pending > 0);

  // A passkey's response travels in a hidden field, submitted by a hidden button that skips the
  // code box's `required`.
  let passkeyResponse = $state('');
  let passkeySubmit: HTMLButtonElement | undefined = $state();
  async function submitPasskey(json: string): Promise<void> {
    passkeyResponse = json;
    await tick();
    passkeySubmit?.form?.requestSubmit(passkeySubmit);
  }
</script>

{#if step.step === 'recoveryCodes'}
  <RecoveryCodes codes={step.codes} {companyName} {dict} />
  <form {...secondFactor}>
    <label class="auth-check">
      <input type="checkbox" required />
      {dict.saved}
    </label>
    <button
      class="auth-button auth-button--primary"
      disabled={busy}
      {...secondFactor.fields.action.as('submit', 'saved')}
    >
      {dict.continue}
    </button>
  </form>
{:else}
  {#if step.step === 'enrol'}
    <p class="auth-intro">{dict.enrolIntro}</p>
    <TotpSetup qrSvg={step.qrSvg} secret={step.secret} {dict} />
  {:else}
    <p class="auth-intro">{dict.verifyIntro}</p>
  {/if}
  {#if refusal !== null}
    <p class="auth-error" id="code-refusal" role="alert">{refusal}</p>
  {/if}
  <form {...secondFactor}>
    <div class="auth-field">
      <label for="code">{dict.code}</label>
      <input
        id="code"
        autocomplete="one-time-code"
        required
        {...secondFactor.fields.code.as('text')}
        aria-invalid={refusal === null ? undefined : 'true'}
        aria-describedby={refusal === null ? undefined : 'code-refusal'}
      />
    </div>
    <button
      class="auth-button auth-button--primary"
      disabled={busy}
      {...secondFactor.fields.action.as('submit', 'code')}
    >
      {step.step === 'enrol' ? dict.enrolSubmit : dict.verifySubmit}
    </button>
    <input {...secondFactor.fields.passkey.as('hidden', passkeyResponse)} />
    <button
      hidden
      formnovalidate
      bind:this={passkeySubmit}
      {...secondFactor.fields.action.as('submit', 'passkey')}
    ></button>
    {#if step.step === 'enrol'}
      <p class="auth-note">{dict.passkeyOr}</p>
      <div class="auth-field">
        <label for="passkey-name">{dict.passkeyName}</label>
        <input
          id="passkey-name"
          maxlength="100"
          {...secondFactor.fields.passkeyName.as('text')}
          placeholder={dict.passkeyDefaultName}
        />
      </div>
      <PasskeyButton
        options={{ kind: 'register', json: step.passkey }}
        label={dict.addPasskey}
        failed={dict.passkeyFailed}
        onresponse={submitPasskey}
      />
    {:else if request !== null}
      <PasskeyButton
        options={{ kind: 'authenticate', json: request }}
        label={dict.usePasskey}
        failed={dict.passkeyFailed}
        onresponse={submitPasskey}
      />
    {/if}
  </form>
{/if}
