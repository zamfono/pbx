<!--
  A labelled form field: label, Expert tag, help text, inline error. `display` renders a value an
  owner sets as plain read-only text for an admin. `flash` scrolls it into view and highlights it
  once (a search result opened it).
-->
<script lang="ts">
  import type { Snippet } from 'svelte';

  import ExpertTag from './ExpertTag.svelte';

  type Props = {
    label: string;
    id?: string;
    help?: string;
    error?: string | null;
    expert?: boolean;
    required?: boolean;
    inline?: boolean;
    flash?: boolean;
    children: Snippet;
  };

  let {
    label,
    id,
    help,
    error = null,
    expert = false,
    required = false,
    inline = false,
    flash = false,
    children
  }: Props = $props();
  let element = $state<HTMLDivElement>();

  $effect(() => {
    if (flash) {
      element?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }
  });
</script>

<div
  class="field"
  class:inline
  class:invalid={error !== null}
  class:flash
  bind:this={element}
>
  <div class="label-row">
    <label for={id}
      >{label}{#if required}<span class="req" aria-hidden="true">*</span
        >{/if}</label
    >
    {#if expert}<ExpertTag />{/if}
  </div>
  <div class="control">{@render children()}</div>
  {#if error !== null}
    <p class="error" role="alert">{error}</p>
  {:else if help}
    <p class="help">{help}</p>
  {/if}
</div>

<style>
  .field {
    display: flex;
    flex-direction: column;
    gap: 6px;
    min-width: 0;
  }
  /* The highlight reaches a little past the field, without moving it. */
  .field.flash {
    margin: -6px -8px;
    padding: 6px 8px;
    border-radius: var(--radius-sm);
  }
  .inline {
    display: grid;
    grid-template-columns: minmax(160px, 260px) 1fr;
    grid-template-areas: 'label control' '. help';
    column-gap: var(--space-4);
    align-items: center;
  }
  .inline .label-row {
    grid-area: label;
  }
  .inline .control {
    grid-area: control;
  }
  .inline .help,
  .inline .error {
    grid-area: help;
  }
  .label-row {
    display: flex;
    align-items: center;
    gap: var(--space-2);
  }
  label {
    font-weight: 700;
    font-size: var(--text-sm);
  }
  .req {
    color: var(--danger);
    margin-left: 2px;
  }
  .help {
    font-size: var(--text-xs);
    color: var(--text-muted);
    line-height: 1.45;
  }
  .error {
    font-size: var(--text-xs);
    color: var(--danger);
    font-weight: 700;
  }
  @media (max-width: 720px) {
    .inline {
      display: flex;
    }
  }
</style>
