<script lang="ts">
  import RecoveryCodes from '#lib/auth/RecoveryCodes.svelte';
  import TotpSetup from '#lib/auth/TotpSetup.svelte';
  import type { Dictionary } from '#lib/i18n/index.js';

  import { secondFactor } from './authorize.remote.js';
  import type { SecondFactorStep } from './secondFactorSubmit.js';

  // The second step of a password sign-in (§5.2 "Two-factor authentication"): a code, the
  // enrolment of an authenticator app, or the recovery codes that enrolment issued.
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
  const busy = $derived(secondFactor.pending > 0);
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
  </form>
{/if}
