<!--
  An on/off switch, optionally with a label and description beside it.
-->
<script lang="ts">
  type Props = {
    checked: boolean;
    id?: string;
    label?: string;
    description?: string;
    disabled?: boolean;
    size?: 'sm' | 'md';
    onchange?: (checked: boolean) => void;
  };

  let {
    checked = $bindable(),
    id,
    label,
    description,
    disabled = false,
    size = 'md',
    onchange
  }: Props = $props();
</script>

<label class="switch {size}" class:disabled for={id}>
  <input
    {id}
    type="checkbox"
    role="switch"
    {disabled}
    {checked}
    onchange={event => {
      checked = event.currentTarget.checked;
      onchange?.(event.currentTarget.checked);
    }}
  />
  <span class="track" aria-hidden="true"><span class="thumb"></span></span>
  {#if label}
    <span class="text">
      <span class="label">{label}</span>
      {#if description}<span class="desc">{description}</span>{/if}
    </span>
  {/if}
</label>

<style>
  .switch {
    display: inline-flex;
    align-items: flex-start;
    gap: 10px;
    cursor: pointer;
  }
  .disabled {
    opacity: 0.55;
    cursor: not-allowed;
  }
  input {
    position: absolute;
    opacity: 0;
    width: 0;
    height: 0;
  }
  .track {
    position: relative;
    flex: none;
    background: var(--line-strong);
    border-radius: var(--radius-pill);
    transition: background 0.18s var(--ease);
  }
  .md .track {
    width: 40px;
    height: 24px;
  }
  .sm .track {
    width: 32px;
    height: 19px;
  }
  .thumb {
    position: absolute;
    top: 3px;
    left: 3px;
    background: #fff;
    border-radius: 50%;
    box-shadow: 0 1px 3px rgb(0 0 0 / 25%);
    transition: transform 0.18s var(--ease);
  }
  .md .thumb {
    width: 18px;
    height: 18px;
  }
  .sm .thumb {
    width: 13px;
    height: 13px;
  }
  input:checked + .track {
    background: var(--primary);
  }
  .md input:checked + .track .thumb {
    transform: translateX(16px);
  }
  .sm input:checked + .track .thumb {
    transform: translateX(13px);
  }
  input:focus-visible + .track {
    outline: 2px solid var(--focus);
    outline-offset: 2px;
  }
  .text {
    display: flex;
    flex-direction: column;
    gap: 1px;
    padding-top: 1px;
  }
  .label {
    font-weight: 700;
    font-size: var(--text-sm);
  }
  .desc {
    font-size: var(--text-xs);
    color: var(--text-muted);
  }
</style>
