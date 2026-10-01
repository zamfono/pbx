<script lang="ts">
  import '../../../app.css';

  import { resolve } from '$app/paths';
  import { page } from '$app/state';

  import type { PageData } from './$types.js';

  const { data }: { data: PageData } = $props();

  const dict = $derived(data.dictionary.error);

  // §5.2 "Authentication pages": the SSO callback and this page's own `redirect_uri`
  // rejection report a `reason` this dictionary has an entry for; any other value falls back to
  // the generic message rather than showing a raw code.
  const message = $derived.by(() => {
    const reason = page.url.searchParams.get('reason');
    const known: Record<string, string> = {
      expired: dict.expired,
      noUser: dict.noUser,
      domain: dict.domain,
      unverifiedEmail: dict.unverifiedEmail,
      issuer: dict.issuer,
      audience: dict.audience,
      signature: dict.signature,
      nonce: dict.nonce
    };
    return (reason === null ? undefined : known[reason]) ?? dict.generic;
  });
</script>

<svelte:head>
  <title>{data.companyName} · {dict.title}</title>
</svelte:head>

<div class="auth-card">
  <h1 class="auth-title">{dict.title}</h1>
  <p class="auth-error">{message}</p>
  <a class="auth-link" href={resolve('/oauth/authorize')}>{dict.backToLogin}</a>
</div>
