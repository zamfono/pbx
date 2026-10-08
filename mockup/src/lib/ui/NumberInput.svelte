<!--
  A whole-number input. With `nullable`, an empty field means null (e.g. "no limit").
-->
<script lang="ts">
  type Props = {
    value: number | null;
    id?: string;
    min?: number;
    max?: number;
    step?: number;
    suffix?: string;
    placeholder?: string;
    nullable?: boolean;
    disabled?: boolean;
    invalid?: boolean;
    onchange?: (value: number | null) => void;
  };

  let {
    value = $bindable(),
    id,
    min,
    max,
    step = 1,
    suffix,
    placeholder,
    nullable = false,
    disabled = false,
    invalid = false,
    onchange
  }: Props = $props();
</script>

<div class="input" class:invalid class:disabled>
  <input
    {id}
    type="number"
    inputmode="numeric"
    {min}
    {max}
    {step}
    {placeholder}
    {disabled}
    aria-invalid={invalid}
    value={value ?? ''}
    oninput={event => {
      const raw = event.currentTarget.value;
      const next = raw === '' ? (nullable ? null : (min ?? 0)) : Number(raw);
      value = next;
      onchange?.(next);
    }}
  />
  {#if suffix}<span class="affix">{suffix}</span>{/if}
</div>

<style>
  .input {
    display: flex;
    align-items: center;
    background: var(--surface);
    border: 1.5px solid var(--line-strong);
    border-radius: var(--radius-sm);
    min-height: 40px;
    max-width: 220px;
  }
  .input:focus-within {
    border-color: var(--primary);
    box-shadow: 0 0 0 3px var(--primary-soft);
  }
  .invalid {
    border-color: var(--danger);
  }
  .disabled {
    opacity: 0.7;
    background: var(--surface-2);
  }
  input {
    flex: 1;
    min-width: 0;
    border: 0;
    background: transparent;
    padding: 8px 12px;
    outline: none;
    font-variant-numeric: tabular-nums;
  }
  .affix {
    padding: 0 12px 0 4px;
    color: var(--text-muted);
    font-size: var(--text-sm);
  }
</style>
