<!--
  A multi-line text input.
-->
<script lang="ts">
  type Props = {
    value: string | null;
    id?: string;
    rows?: number;
    mono?: boolean;
    placeholder?: string;
    disabled?: boolean;
    invalid?: boolean;
    oninput?: (value: string) => void;
  };

  let {
    value = $bindable(),
    id,
    rows = 5,
    mono = false,
    placeholder,
    disabled = false,
    invalid = false,
    oninput
  }: Props = $props();
</script>

<textarea
  {id}
  {rows}
  {placeholder}
  {disabled}
  class:mono
  class:invalid
  value={value ?? ''}
  oninput={event => {
    value = event.currentTarget.value;
    oninput?.(event.currentTarget.value);
  }}></textarea>

<style>
  textarea {
    width: 100%;
    background: var(--surface);
    border: 1.5px solid var(--line-strong);
    border-radius: var(--radius-sm);
    padding: 10px 12px;
    resize: vertical;
    outline: none;
    line-height: 1.5;
  }
  textarea:focus {
    border-color: var(--primary);
    box-shadow: 0 0 0 3px var(--primary-soft);
  }
  .mono {
    font-family: var(--font-mono);
    font-size: 13px;
  }
  .invalid {
    border-color: var(--danger);
  }
</style>
