<script lang="ts">
  import '../app.css';

  import type { LayoutProps } from './$types.js';

  // The stylesheet of every page and error page this app renders, the authentication pages
  // (§5.2 "Authentication pages"); the `+server.ts` endpoints render nothing through it.
  const { children }: LayoutProps = $props();
</script>

{@render children()}
