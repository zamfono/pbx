<!--
  A text input, optionally monospace, with prefix/suffix text.
-->
<script lang="ts">
  type Props = {
    value: string | null;
    id?: string;
    type?:
      | 'text'
      | 'email'
      | 'url'
      | 'tel'
      | 'password'
      | 'search'
      | 'time'
      | 'date'
      | 'datetime-local';
    placeholder?: string;
    mono?: boolean;
    prefix?: string;
    suffix?: string;
    disabled?: boolean;
    readonly?: boolean;
    invalid?: boolean;
    autocomplete?: HTMLInputElement['autocomplete'];
    oninput?: (value: string) => void;
    onenter?: () => void;
  };

  let {
    value = $bindable(),
    id,
    type = 'text',
    placeholder,
    mono = false,
    prefix,
    suffix,
    disabled = false,
    readonly = false,
    invalid = false,
    autocomplete,
    oninput,
    onenter
  }: Props = $props();
</script>

<div class="input" class:mono class:invalid class:disabled>
  {#if prefix}<span class="affix">{prefix}</span>{/if}
  <input
    {id}
    {type}
    {placeholder}
    {disabled}
    {readonly}
    {autocomplete}
    aria-invalid={invalid}
    value={value ?? ''}
    oninput={event => {
      value = event.currentTarget.value;
      oninput?.(event.currentTarget.value);
    }}
    onkeydown={event => {
      if (event.key === 'Enter') {
        onenter?.();
      }
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
    transition:
      border-color 0.15s var(--ease),
      box-shadow 0.15s var(--ease);
    min-width: 0;
  }
  .input:focus-within {
    border-color: var(--primary);
    box-shadow: 0 0 0 3px var(--primary-soft);
  }
  .invalid {
    border-color: var(--danger);
  }
  .disabled {
    background: var(--surface-2);
    opacity: 0.7;
  }
  input {
    flex: 1;
    min-width: 0;
    border: 0;
    background: transparent;
    padding: 8px 12px;
    outline: none;
    font-size: var(--text-md);
  }
  .mono input {
    font-family: var(--font-mono);
    font-size: 13px;
  }
  .affix {
    padding: 0 10px;
    color: var(--text-muted);
    font-size: var(--text-sm);
    white-space: nowrap;
  }
</style>
