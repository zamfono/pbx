<script lang="ts">
  import {
    startAuthentication,
    startRegistration,
    type PublicKeyCredentialCreationOptionsJSON,
    type PublicKeyCredentialRequestOptionsJSON
  } from '@simplewebauthn/browser';
  import { onMount } from 'svelte';

  // A passkey through the browser's own prompt (§5.2 "Two-factor authentication"): registering a
  // new one or signing in with one, handing the browser's response, as JSON, to `onresponse`.
  // WebAuthn needs scripts, so the button appears only once the page runs in a browser.
  const {
    options,
    label,
    failed,
    onresponse
  }: {
    options:
      | { kind: 'register'; json: PublicKeyCredentialCreationOptionsJSON }
      | { kind: 'authenticate'; json: PublicKeyCredentialRequestOptionsJSON };
    label: string;
    failed: string;
    onresponse: (json: string) => void;
  } = $props();

  let scripted = $state(false);
  let busy = $state(false);
  let refusal: string | null = $state(null);
  onMount(() => {
    scripted = true;
  });

  async function prompt(): Promise<void> {
    refusal = null;
    busy = true;
    try {
      const response =
        options.kind === 'register'
          ? await startRegistration({ optionsJSON: options.json })
          : await startAuthentication({ optionsJSON: options.json });
      onresponse(JSON.stringify(response));
    } catch {
      // The person cancelled the prompt, or the device has no passkey for this site.
      refusal = failed;
    } finally {
      busy = false;
    }
  }
</script>

{#if scripted}
  <button
    class="auth-button auth-button--secondary"
    type="button"
    disabled={busy}
    onclick={prompt}
  >
    {label}
  </button>
  {#if refusal !== null}
    <p class="auth-error" role="alert">{refusal}</p>
  {/if}
{/if}
