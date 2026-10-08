<!--
  A value shown as plain text where the person may see but not change it (an owner's setting,
  seen by an admin).
-->
<script lang="ts">
  import type { Snippet } from 'svelte';

  let { children, mono = false }: { children: Snippet; mono?: boolean } =
    $props();
</script>

<div class="display" class:mono>{@render children()}</div>

<style>
  .display {
    padding: 8px 0;
    min-height: 40px;
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 6px;
    color: var(--text);
  }
  .mono {
    font-family: var(--font-mono);
    font-size: 13px;
  }
</style>
