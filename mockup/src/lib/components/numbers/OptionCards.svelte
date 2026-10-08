<!--
  A choice between a few options, each explained in a sentence: a radio group laid out as cards.
-->
<script lang="ts" generics="V extends string">
  type Option = {
    value: V;
    label: string;
    description: string;
    disabled?: boolean;
  };
  type Props = {
    value: V;
    options: Option[];
    name: string;
    id?: string;
    disabled?: boolean;
    columns?: number;
    onchange: (value: V) => void;
  };

  let {
    value,
    options,
    name,
    id,
    disabled = false,
    columns = options.length,
    onchange
  }: Props = $props();
</script>

<div class="cards" role="radiogroup" {id} style:--columns={columns}>
  {#each options as option (option.value)}
    <label
      class="card"
      class:on={option.value === value}
      class:off={disabled || option.disabled}
    >
      <input
        type="radio"
        {name}
        value={option.value}
        checked={option.value === value}
        disabled={disabled || option.disabled}
        onchange={() => onchange(option.value)}
      />
      <span class="title"
        ><span class="dot" aria-hidden="true"></span>{option.label}</span
      >
      <span class="description">{option.description}</span>
    </label>
  {/each}
</div>

<style>
  .cards {
    display: grid;
    grid-template-columns: repeat(var(--columns), minmax(0, 1fr));
    gap: var(--space-2);
  }
  .card {
    position: relative;
    display: flex;
    flex-direction: column;
    gap: 4px;
    padding: var(--space-3) var(--space-4);
    border: 1.5px solid var(--line-strong);
    border-radius: var(--radius-sm);
    background: var(--surface);
    cursor: pointer;
    transition:
      border-color 0.15s var(--ease),
      background 0.15s var(--ease);
  }
  .card:hover {
    border-color: var(--primary);
  }
  .card.on {
    border-color: var(--primary);
    background: var(--primary-soft);
  }
  .card.off {
    cursor: not-allowed;
    opacity: 0.6;
  }
  input {
    position: absolute;
    opacity: 0;
    width: 0;
    height: 0;
  }
  .card:has(input:focus-visible) {
    outline: 2px solid var(--focus);
    outline-offset: 2px;
  }
  .title {
    display: flex;
    align-items: center;
    gap: 8px;
    font-weight: 700;
    font-size: var(--text-sm);
  }
  .dot {
    width: 14px;
    height: 14px;
    border-radius: 50%;
    border: 2px solid var(--line-strong);
    flex: none;
  }
  .on .dot {
    border-color: var(--primary);
    background: radial-gradient(circle, var(--primary) 0 3px, transparent 4px);
  }
  .description {
    font-size: var(--text-xs);
    color: var(--text-muted);
    line-height: 1.45;
  }
  @media (max-width: 720px) {
    .cards {
      grid-template-columns: 1fr;
    }
  }
</style>
