<script lang="ts">
  import '../../../app.css';

  import { page } from '$app/state';

  import { format } from '../../../lib/i18n/index.js';
  import type { PageData } from './$types.js';

  const { data }: { data: PageData } = $props();

  const dict = $derived(data.dictionary.done);
  const message = $derived(format(dict.message, { company: data.companyName }));
  // §10.5: the MCP connect command a person runs after a sign-in with no client to return to.
  const mcpCommand = $derived(
    `claude mcp add --transport http zamfono https://${page.url.hostname}/mcp`
  );
</script>

<svelte:head>
  <title>{data.companyName} · {dict.title}</title>
</svelte:head>

<div class="auth-card">
  <h1 class="auth-title">{dict.title}</h1>
  <p class="auth-note">{message}</p>
  <p class="auth-note">{dict.mcpHint}</p>
  <code class="auth-command">{mcpCommand}</code>
</div>
