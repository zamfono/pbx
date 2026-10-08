<!--
  A route that does not exist.
-->
<script lang="ts">
  import NotFound from '#lib/shell/NotFound.svelte';
</script>

<div class="error-page"><NotFound /></div>

<style>
  .error-page {
    max-width: 640px;
    margin: 10vh auto;
    padding: 0 var(--space-4);
  }
</style>
