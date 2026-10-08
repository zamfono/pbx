<!--
  The title row of a page: optional back link, title, subtitle, actions.
-->
<script lang="ts">
  import ArrowLeft from '@lucide/svelte/icons/arrow-left';
  import type { Snippet } from 'svelte';

  type Props = {
    title: string;
    subtitle?: string;
    back?: { href: string; label: string };
    meta?: Snippet;
    actions?: Snippet;
  };

  let { title, subtitle, back, meta, actions }: Props = $props();
</script>

<header class="page-header">
  {#if back}
    <a class="back" href={back.href}><ArrowLeft size={15} /> {back.label}</a>
  {/if}
  <div class="row-main">
    <div class="titles">
      <h1>{title}</h1>
      {#if subtitle}<p class="subtitle">{subtitle}</p>{/if}
      {#if meta}<div class="meta">{@render meta()}</div>{/if}
    </div>
    {#if actions}<div class="actions">{@render actions()}</div>{/if}
  </div>
</header>

<style>
  .page-header {
    margin-bottom: var(--space-5);
  }
  .back {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    font-size: var(--text-sm);
    font-weight: 700;
    color: var(--text-muted);
    margin-bottom: var(--space-2);
  }
  .back:hover {
    color: var(--primary);
    text-decoration: none;
  }
  .row-main {
    display: flex;
    align-items: flex-end;
    justify-content: space-between;
    gap: var(--space-4);
    flex-wrap: wrap;
  }
  .titles {
    min-width: 0;
  }
  .subtitle {
    color: var(--text-muted);
    margin-top: 6px;
    max-width: 70ch;
  }
  .meta {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2);
    margin-top: var(--space-3);
    align-items: center;
  }
  .actions {
    display: flex;
    gap: var(--space-2);
    flex-wrap: wrap;
  }
  @media (max-width: 640px) {
    .page-header :global(h1) {
      font-size: var(--text-2xl);
    }
    .actions {
      width: 100%;
    }
  }
</style>
