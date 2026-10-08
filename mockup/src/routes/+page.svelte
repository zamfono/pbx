<!--
  The start: the overview when signed in, else the sign-in screen.
-->
<script lang="ts">
  import { go } from '#lib/state/router.svelte.js';
  import { session } from '#lib/state/session.svelte.js';

  $effect(() => {
    go(session.signedIn ? '/overview' : '/auth/signin', { replace: true });
  });
</script>
