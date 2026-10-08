<!--
  A length of time entered as a number and a unit (seconds, minutes, hours, days); the value is
  whole seconds, as the API takes it.
-->
<script lang="ts">
  import { t } from '#lib/i18n/index.svelte.js';
  import NumberInput from '#lib/ui/NumberInput.svelte';
  import Select from '#lib/ui/Select.svelte';

  type Props = {
    value: number;
    id?: string;
    min?: number;
    invalid?: boolean;
    onchange: (seconds: number) => void;
  };

  let { value, id, min = 0, invalid = false, onchange }: Props = $props();

  const UNITS = [86_400, 3600, 60, 1] as const;
  const fitting = (seconds: number): number =>
    UNITS.find(unit => seconds !== 0 && seconds % unit === 0) ?? 1;

  let chosen = $state<number | null>(null);
  const unit = $derived(chosen ?? fitting(value));
  const amount = $derived(value / unit);
  const unitOptions = $derived(
    UNITS.map(size => ({ value: size, label: t(`system.unit.${size}`) }))
  );
</script>

<div class="duration">
  <NumberInput
    {id}
    value={Number.isInteger(amount) ? amount : Number(amount.toFixed(2))}
    min={Math.ceil(min / unit)}
    {invalid}
    onchange={next => onchange(Math.round((next ?? 0) * unit))}
  />
  <Select
    value={unit}
    options={unitOptions}
    onchange={next => {
      chosen = next;
      onchange(Math.round(amount) * next);
    }}
  />
</div>

<style>
  .duration {
    display: grid;
    grid-template-columns: minmax(80px, 1fr) minmax(110px, 140px);
    gap: var(--space-2);
  }
</style>
