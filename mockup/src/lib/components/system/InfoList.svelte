<!--
  Label/value pairs, two columns on wide screens and stacked on phones.
-->
<script lang="ts">
  import type { Snippet } from 'svelte';

  type Item = {
    label: string;
    value?: string;
    mono?: boolean;
    content?: Snippet;
  };
  let { items }: { items: Item[] } = $props();
</script>

<dl class="info">
  {#each items as item (item.label)}
    <div class="pair">
      <dt>{item.label}</dt>
      <dd class:mono={item.mono}>
        {#if item.content}{@render item.content()}{:else}{item.value ??
            '—'}{/if}
      </dd>
    </div>
  {/each}
</dl>

<style>
  .info {
    margin: 0;
    display: flex;
    flex-direction: column;
  }
  .pair {
    display: grid;
    grid-template-columns: minmax(130px, 38%) 1fr;
    gap: var(--space-3);
    padding: 9px 0;
    border-bottom: 1px solid var(--line);
  }
  .pair:last-child {
    border-bottom: 0;
  }
  dt {
    color: var(--text-muted);
    font-size: var(--text-sm);
  }
  dd {
    margin: 0;
    font-weight: 600;
    min-width: 0;
    overflow-wrap: anywhere;
    display: flex;
    align-items: center;
    gap: 6px;
    flex-wrap: wrap;
  }
  .mono {
    font-family: var(--font-mono);
    font-size: 12.5px;
    font-weight: 500;
  }
  @media (max-width: 480px) {
    .pair {
      grid-template-columns: 1fr;
      gap: 2px;
    }
  }
</style>
