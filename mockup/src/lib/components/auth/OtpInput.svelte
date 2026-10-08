<!--
  Six digit boxes for an authenticator code: one real input (paste, autofill `one-time-code`) under
  six boxes that show its digits. `oncomplete` fires once all six are typed.
-->
<script lang="ts">
  type Props = {
    value: string;
    id?: string;
    label: string;
    invalid?: boolean;
    disabled?: boolean;
    autofocus?: boolean;
    oncomplete?: (code: string) => void;
  };
  let {
    value = $bindable(),
    id,
    label,
    invalid = false,
    disabled = false,
    autofocus = false,
    oncomplete
  }: Props = $props();

  const LENGTH = 6;
  let focused = $state(false);
  const digits = $derived(
    Array.from({ length: LENGTH }, (_, index) => value[index] ?? '')
  );
  const active = $derived(Math.min(value.length, LENGTH - 1));
</script>

<div class="otp" class:invalid class:focused class:disabled>
  <input
    {@attach node => {
      if (autofocus) {
        node.focus();
      }
    }}
    {id}
    {disabled}
    aria-label={label}
    aria-invalid={invalid}
    inputmode="numeric"
    autocomplete="one-time-code"
    maxlength={LENGTH}
    {value}
    onfocus={() => (focused = true)}
    onblur={() => (focused = false)}
    oninput={event => {
      const cleaned = event.currentTarget.value
        .replaceAll(/\D/gu, '')
        .slice(0, LENGTH);
      event.currentTarget.value = cleaned;
      value = cleaned;
      if (cleaned.length === LENGTH) {
        oncomplete?.(cleaned);
      }
    }}
  />
  <div class="boxes" aria-hidden="true">
    {#each digits as digit, index (index)}
      <span
        class="box"
        class:filled={digit !== ''}
        class:current={focused && index === active}
        class:gap={index === 2}>{digit}</span
      >
    {/each}
  </div>
</div>

<style>
  .otp {
    position: relative;
    width: 100%;
    max-width: 340px;
  }
  input {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    opacity: 0;
    font-size: 16px;
    cursor: text;
    z-index: 1;
  }
  .boxes {
    display: grid;
    grid-template-columns: repeat(6, 1fr);
    gap: var(--space-2);
  }
  .box {
    display: grid;
    place-items: center;
    aspect-ratio: 5 / 6;
    border-radius: var(--radius-sm);
    border: 1.5px solid var(--line-strong);
    background: var(--surface-2);
    font-family: var(--font-display);
    font-weight: 800;
    font-size: var(--text-2xl);
    color: var(--text);
    transition:
      border-color 0.15s var(--ease),
      box-shadow 0.15s var(--ease),
      transform 0.15s var(--ease);
  }
  .gap {
    margin-right: var(--space-2);
  }
  .filled {
    border-color: var(--primary);
    background: var(--surface);
  }
  .current {
    border-color: var(--primary);
    box-shadow: 0 0 0 3px var(--primary-soft);
    transform: translateY(-1px);
  }
  .invalid .box {
    border-color: var(--danger);
    animation: shake 0.35s var(--ease);
  }
  .disabled {
    opacity: 0.6;
  }
  @keyframes shake {
    25% {
      transform: translateX(-3px);
    }
    75% {
      transform: translateX(3px);
    }
  }
</style>
