<!--
  Renders the app-wide confirmation dialog (`confirmDialog`).
-->
<script lang="ts">
  import TriangleAlert from '@lucide/svelte/icons/triangle-alert';

  import { ui } from '#lib/state/ui.svelte.js';

  import Button from './Button.svelte';
  import Dialog from './Dialog.svelte';
</script>

{#if ui.dialog}
  {@const dialog = ui.dialog}
  <Dialog
    open
    title={dialog.title}
    size="sm"
    onclose={() => dialog.resolve(false)}
  >
    <p class="body">{dialog.body}</p>
    {#if dialog.note}
      <p class="note"><TriangleAlert size={16} /> {dialog.note}</p>
    {/if}
    {#snippet footer()}
      <Button variant="ghost" onclick={() => dialog.resolve(false)}
        >{dialog.cancelLabel}</Button
      >
      <Button
        variant={dialog.tone === 'danger' ? 'danger' : 'primary'}
        onclick={() => dialog.resolve(true)}>{dialog.confirmLabel}</Button
      >
    {/snippet}
  </Dialog>
{/if}

<style>
  .body {
    color: var(--text-muted);
    white-space: pre-line;
  }
  .note {
    display: flex;
    gap: 8px;
    align-items: flex-start;
    margin-top: var(--space-4);
    padding: var(--space-3);
    border-radius: var(--radius-sm);
    background: var(--warn-soft);
    color: var(--warn);
    font-weight: 700;
    font-size: var(--text-sm);
  }
</style>
