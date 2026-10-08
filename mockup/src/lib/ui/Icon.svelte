<!--
  One icon: a Lucide icon component, or a Lucide Labs icon node (`@lucide/lab`).
-->
<script lang="ts">
  import { Icon as LucideIcon, type IconNode } from '@lucide/svelte';
  import type { Component } from 'svelte';

  type Props = {
    icon: Component | IconNode;
    size?: number;
    strokeWidth?: number;
    class?: string;
  };

  let {
    icon,
    size = 18,
    strokeWidth = 2,
    class: className = ''
  }: Props = $props();
  const isNode = $derived(Array.isArray(icon));
</script>

{#if isNode}
  <LucideIcon
    iconNode={icon as IconNode}
    {size}
    {strokeWidth}
    class={className}
    aria-hidden="true"
  />
{:else}
  {@const Glyph = icon as Component<Record<string, unknown>>}
  <Glyph {size} {strokeWidth} class={className} aria-hidden="true" />
{/if}
