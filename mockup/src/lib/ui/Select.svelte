<!--
  A native select with the app's styling.
-->
<script lang="ts" generics="V extends string | number | null">
  type Option = { value: V; label: string; disabled?: boolean };
  type Props = {
    value: V;
    options: Option[];
    id?: string;
    disabled?: boolean;
    invalid?: boolean;
    onchange?: (value: V) => void;
  };

  let {
    value = $bindable(),
    options,
    id,
    disabled = false,
    invalid = false,
    onchange
  }: Props = $props();
  const index = $derived(options.findIndex(option => option.value === value));
</script>

<div class="select" class:invalid class:disabled>
  <select
    {id}
    {disabled}
    value={String(index)}
    onchange={event => {
      const picked = options[Number(event.currentTarget.value)];
      if (picked !== undefined) {
        value = picked.value;
        onchange?.(picked.value);
      }
    }}
  >
    {#if index === -1}<option value="-1" disabled>—</option>{/if}
    {#each options as option, position (position)}
      <option value={String(position)} disabled={option.disabled}
        >{option.label}</option
      >
    {/each}
  </select>
</div>

<style>
  .select {
    position: relative;
    min-width: 0;
  }
  .select::after {
    content: '';
    position: absolute;
    right: 14px;
    top: 50%;
    width: 7px;
    height: 7px;
    border-right: 2px solid var(--text-muted);
    border-bottom: 2px solid var(--text-muted);
    transform: translateY(-70%) rotate(45deg);
    pointer-events: none;
  }
  select {
    appearance: none;
    width: 100%;
    min-height: 40px;
    padding: 8px 36px 8px 12px;
    background: var(--surface);
    border: 1.5px solid var(--line-strong);
    border-radius: var(--radius-sm);
    cursor: pointer;
    outline: none;
  }
  select:focus {
    border-color: var(--primary);
    box-shadow: 0 0 0 3px var(--primary-soft);
  }
  .invalid select {
    border-color: var(--danger);
  }
  .disabled select {
    opacity: 0.7;
    cursor: not-allowed;
  }
</style>
