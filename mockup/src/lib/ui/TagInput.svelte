<!--
  A list of short strings (numbers, IPs, codes) edited as removable chips. `validate` returns an
  error text for a value it rejects.
-->
<script lang="ts">
  import X from '@lucide/svelte/icons/x';

  import { t } from '#lib/i18n/index.svelte.js';

  type Props = {
    values: string[];
    id?: string;
    placeholder?: string;
    mono?: boolean;
    disabled?: boolean;
    validate?: (value: string) => string | null;
    onchange?: (values: string[]) => void;
  };

  let {
    values = $bindable(),
    id,
    placeholder,
    mono = true,
    disabled = false,
    validate,
    onchange
  }: Props = $props();
  let draft = $state('');
  let error = $state<string | null>(null);

  function add(): void {
    const value = draft.trim();
    if (value === '') {
      return;
    }
    const problem = validate?.(value) ?? null;
    if (problem !== null) {
      error = problem;
      return;
    }
    if (!values.includes(value)) {
      values = [...values, value];
      onchange?.(values);
    }
    draft = '';
    error = null;
  }

  function remove(value: string): void {
    values = values.filter(item => item !== value);
    onchange?.(values);
  }
</script>

<div class="tags" class:disabled class:invalid={error !== null}>
  {#each values as value (value)}
    <span class="tag" class:mono>
      {value}
      {#if !disabled}
        <button
          type="button"
          aria-label={t('common.remove')}
          onclick={() => remove(value)}><X size={12} /></button
        >
      {/if}
    </span>
  {/each}
  {#if !disabled}
    <input
      {id}
      class:mono
      {placeholder}
      bind:value={draft}
      onkeydown={event => {
        if (event.key === 'Enter' || event.key === ',') {
          event.preventDefault();
          add();
        } else if (
          event.key === 'Backspace' &&
          draft === '' &&
          values.length > 0
        ) {
          remove(values[values.length - 1] ?? '');
        }
      }}
      onblur={add}
    />
  {/if}
</div>
{#if error !== null}<p class="error">{error}</p>{/if}

<style>
  .tags {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    align-items: center;
    min-height: 40px;
    padding: 5px 8px;
    background: var(--surface);
    border: 1.5px solid var(--line-strong);
    border-radius: var(--radius-sm);
  }
  .tags:focus-within {
    border-color: var(--primary);
    box-shadow: 0 0 0 3px var(--primary-soft);
  }
  .invalid {
    border-color: var(--danger);
  }
  .disabled {
    background: var(--surface-2);
  }
  .tag {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 3px 4px 3px 10px;
    background: var(--primary-soft);
    color: var(--primary);
    border-radius: var(--radius-pill);
    font-size: var(--text-sm);
    font-weight: 700;
  }
  .disabled .tag {
    padding-right: 10px;
  }
  .mono {
    font-family: var(--font-mono);
    font-size: 12.5px;
  }
  .tag button {
    display: grid;
    place-items: center;
    border: 0;
    background: transparent;
    color: inherit;
    width: 18px;
    height: 18px;
    border-radius: 50%;
    cursor: pointer;
  }
  .tag button:hover {
    background: rgb(0 0 0 / 10%);
  }
  input {
    flex: 1;
    min-width: 120px;
    border: 0;
    outline: none;
    background: transparent;
    padding: 4px;
  }
  .error {
    font-size: var(--text-xs);
    color: var(--danger);
    font-weight: 700;
    margin-top: 4px;
  }
</style>
