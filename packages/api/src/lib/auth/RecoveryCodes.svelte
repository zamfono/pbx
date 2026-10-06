<script lang="ts">
  import { onMount } from 'svelte';

  import type { Dictionary } from '#lib/i18n/index.js';

  // Freshly issued recovery codes (§5.2 "Two-factor authentication"), shown this once: as a list,
  // as a .txt download, and, where the browser runs scripts, onto the clipboard.
  const {
    codes,
    companyName,
    dict
  }: { codes: string[]; companyName: string; dict: Dictionary['mfa'] } =
    $props();

  const text = $derived(`${companyName}\n\n${codes.join('\n')}\n`);
  // A `data:` link downloads without any script, so the codes can be saved in every browser.
  const download = $derived(
    `data:text/plain;charset=utf-8,${encodeURIComponent(text)}`
  );
  // The copy button needs the Clipboard API, so it appears only once the page runs in a browser.
  let scripted = $state(false);
  let copied = $state(false);
  onMount(() => {
    scripted = true;
  });

  async function copy(): Promise<void> {
    await navigator.clipboard.writeText(text);
    copied = true;
  }
</script>

<p class="auth-intro">{dict.codesIntro}</p>
<ul class="auth-codes">
  {#each codes as code (code)}
    <li>{code}</li>
  {/each}
</ul>
<div class="auth-actions">
  {#if scripted}
    <button
      class="auth-button auth-button--secondary"
      type="button"
      onclick={copy}
    >
      {copied ? dict.copied : dict.copy}
    </button>
  {/if}
  <a class="auth-link" href={download} download="recovery-codes.txt">
    {dict.download}
  </a>
</div>
