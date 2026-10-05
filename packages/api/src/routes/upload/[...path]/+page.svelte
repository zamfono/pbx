<script lang="ts">
  import { page } from '$app/state';

  import type { PageData } from './$types.js';
  import { upload } from './upload.remote.js';

  const { data }: { data: PageData } = $props();

  const dict = $derived(data.dictionary.upload);
  const outcome = $derived(upload.result ?? null);
  const refusal = $derived(
    outcome !== null && 'refusal' in outcome ? outcome.refusal : null
  );
  const busy = $derived(upload.pending > 0);
  const link = $derived(`${page.url.pathname}${page.url.search}`);
  // A submission without JavaScript posts to the form's `?/remote=…` action, which replaces this
  // page's query string; carrying the link's own query in it as well lets the re-rendered page's
  // `load` find the token it is answering.
  const action = $derived(
    page.url.search === ''
      ? upload.action
      : `${page.url.search}&${upload.action.slice(1)}`
  );
</script>

<svelte:head>
  <title>{data.companyName} · {dict.title}</title>
</svelte:head>

<div class="auth-card">
  <h1 class="auth-title">{dict.title}</h1>
  {#if outcome !== null && 'uploaded' in outcome}
    <p class="auth-note" role="status">{dict.uploaded}</p>
  {:else if !data.live}
    <p class="auth-error">{dict.expired}</p>
  {:else}
    {#if refusal !== null}
      <p class="auth-error" id="refusal" role="alert">{refusal}</p>
    {/if}
    <form {...upload} {action} enctype="multipart/form-data">
      <input {...upload.fields.link.as('hidden', link)} />
      <div class="auth-field">
        <label for="upload">{dict.file}</label>
        <input
          id="upload"
          accept="audio/wav,audio/mpeg,.wav,.mp3"
          required
          {...upload.fields.upload.as('file')}
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
