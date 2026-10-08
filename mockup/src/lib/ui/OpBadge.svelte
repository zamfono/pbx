<!--
  An operation name as data (e.g. an audit entry's `operation`), shown in Expert mode only.
-->
<script lang="ts">
  import { isExpert } from '#lib/state/session.svelte.js';

  let { op }: { op: string } = $props();
</script>

{#if isExpert()}
  <span class="op" title={op}>{op}</span>
{/if}

<style>
  .op {
    font-family: var(--font-mono);
    font-size: 10.5px;
    line-height: 1;
    padding: 3px 6px;
    border-radius: var(--radius-xs);
    background: var(--surface-3);
    color: var(--text-muted);
    white-space: nowrap;
    font-weight: 500;
  }
</style>
