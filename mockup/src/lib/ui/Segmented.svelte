<!--
  A segmented control for a few mutually exclusive choices.
-->
<script lang="ts" generics="V extends string | number | boolean | null">
  type Props = {
    value: V;
    options: { value: V; label: string }[];
    disabled?: boolean;
    size?: 'sm' | 'md';
    ariaLabel?: string;
    onchange?: (value: V) => void;
  };

  let {
    value = $bindable(),
    options,
    disabled = false,
    size = 'md',
    ariaLabel,
    onchange
  }: Props = $props();
</script>

<div class="seg {size}" role="radiogroup" aria-label={ariaLabel}>
  {#each options as option (String(option.value))}
    <button
      type="button"
      role="radio"
      aria-checked={option.value === value}
      class:on={option.value === value}
      {disabled}
      onclick={() => {
        value = option.value;
        onchange?.(option.value);
      }}
    >
      {option.label}
    </button>
  {/each}
</div>

<style>
  .seg {
    display: inline-flex;
    flex-wrap: wrap;
    padding: 3px;
    gap: 2px;
    background: var(--surface-3);
    border-radius: var(--radius-pill);
    max-width: 100%;
  }
  button {
    border: 0;
    background: transparent;
    border-radius: var(--radius-pill);
    cursor: pointer;
    font-weight: 700;
    color: var(--text-muted);
    white-space: nowrap;
  }
  .md button {
    padding: 6px 14px;
    font-size: var(--text-sm);
  }
  .sm button {
    padding: 3px 10px;
    font-size: var(--text-xs);
  }
  button.on {
    background: var(--surface);
    color: var(--primary);
    box-shadow: var(--shadow-sm);
  }
  button:disabled {
    cursor: not-allowed;
    opacity: 0.6;
  }
</style>
