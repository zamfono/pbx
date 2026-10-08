<!--
  Mucki's light markdown, rendered from parsed blocks (no raw HTML). App links navigate in place.
-->
<script lang="ts">
  import { go } from '#lib/state/router.svelte.js';

  import { parseMarkdown, type Inline } from './markdown';

  let { text, onnavigate }: { text: string; onnavigate?: () => void } =
    $props();

  const blocks = $derived(parseMarkdown(text));

  function open(event: MouseEvent, href: string): void {
    event.preventDefault();
    go(href);
    onnavigate?.();
  }
</script>

{#snippet inline(parts: Inline[])}
  {#each parts as part, index (index)}
    {#if part.type === 'text'}{part.text}{:else if part.type === 'bold'}<strong
        >{part.text}</strong
      >{:else if part.type === 'code'}<code>{part.text}</code
      >{:else if part.type === 'br'}<br />{:else if part.app}<a
        href={part.href}
        onclick={event => open(event, part.href)}>{part.text}</a
      >{:else}<a href={part.href} target="_blank" rel="noopener noreferrer"
        >{part.text}</a
      >{/if}
  {/each}
{/snippet}

<div class="md">
  {#each blocks as block, index (index)}
    {#if block.type === 'p'}
      <p>{@render inline(block.inline)}</p>
    {:else if block.type === 'ul'}
      <ul>
        {#each block.items as item, itemIndex (itemIndex)}
          <li>{@render inline(item)}</li>
        {/each}
      </ul>
    {:else}
      <ol>
        {#each block.items as item, itemIndex (itemIndex)}
          <li>{@render inline(item)}</li>
        {/each}
      </ol>
    {/if}
  {/each}
</div>

<style>
  .md {
    display: flex;
    flex-direction: column;
    gap: 8px;
    overflow-wrap: anywhere;
  }
  p,
  ul,
  ol {
    margin: 0;
  }
  ul,
  ol {
    padding-left: 1.2em;
    display: flex;
    flex-direction: column;
    gap: 3px;
  }
  li::marker {
    color: var(--mucki);
  }
  strong {
    font-weight: 700;
  }
  code {
    font-family: var(--font-mono);
    font-size: 0.88em;
    background: var(--surface-3);
    border-radius: var(--radius-xs);
    padding: 1px 5px;
  }
  a {
    color: var(--mucki-text);
    font-weight: 600;
  }
</style>
