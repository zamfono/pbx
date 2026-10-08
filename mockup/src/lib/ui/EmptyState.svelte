<!--
  What an empty list shows: icon, title, one line, an action.
-->
<script lang="ts">
  import type { IconNode } from '@lucide/svelte';
  import type { Component, Snippet } from 'svelte';

  import Icon from './Icon.svelte';

  type Props = {
    icon: Component | IconNode;
    title: string;
    body?: string;
    action?: Snippet;
  };
  let { icon, title, body, action }: Props = $props();
</script>

<div class="empty">
  <span class="icon"><Icon {icon} size={26} /></span>
  <h3>{title}</h3>
  {#if body}<p>{body}</p>{/if}
  {#if action}<div class="action">{@render action()}</div>{/if}
</div>

<style>
  .empty {
    display: flex;
    flex-direction: column;
    align-items: center;
    text-align: center;
    gap: var(--space-2);
    padding: var(--space-7) var(--space-5);
    background: var(--surface);
    border: 1.5px dashed var(--line-strong);
    border-radius: var(--radius-md);
  }
  .icon {
    display: grid;
    place-items: center;
    width: 56px;
    height: 56px;
    border-radius: 50%;
    background: var(--primary-soft);
    color: var(--primary);
    margin-bottom: var(--space-2);
  }
  p {
    color: var(--text-muted);
    max-width: 46ch;
  }
  .action {
    margin-top: var(--space-3);
  }
</style>
