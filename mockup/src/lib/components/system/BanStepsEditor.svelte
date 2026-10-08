<!--
  `sipBanSteps`: the ban length for an address's first, second, … consecutive ban, each longer
  than the one before, permanent (null) only as the last; an empty list switches banning off.
-->
<script lang="ts">
  import Plus from '@lucide/svelte/icons/plus';
  import X from '@lucide/svelte/icons/x';

  import { t } from '#lib/i18n/index.svelte.js';
  import Button from '#lib/ui/Button.svelte';
  import IconButton from '#lib/ui/IconButton.svelte';
  import Switch from '#lib/ui/Switch.svelte';

  import DurationInput from './DurationInput.svelte';

  type Props = {
    value: (number | null)[];
    id?: string;
    invalid?: boolean;
    onchange: (steps: (number | null)[]) => void;
  };
  let {
    value,
    id = 'sipBanSteps',
    invalid = false,
    onchange
  }: Props = $props();

  const DEFAULT_STEPS: (number | null)[] = [86_400, 31_536_000, null];
  const DAY = 86_400;
  const finite = $derived(
    value.filter((step): step is number => step !== null)
  );
  const permanent = $derived(value.at(-1) === null && value.length > 0);

  function setFinite(index: number, seconds: number): void {
    const next = [...finite];
    next[index] = seconds;
    onchange(permanent ? [...next, null] : next);
  }

  function removeFinite(index: number): void {
    const next = finite.filter((_, position) => position !== index);
    onchange(
      next.length === 0 && !permanent ? [] : permanent ? [...next, null] : next
    );
  }

  function addStep(): void {
    const last = finite.at(-1);
    const next = [...finite, last === undefined ? DAY : last * 2];
    onchange(permanent ? [...next, null] : next);
  }
</script>

<div class="steps" {id}>
  <Switch
    id="{id}-on"
    checked={value.length > 0}
    label={t('sipProtection.steps.on')}
    description={value.length > 0
      ? undefined
      : t('sipProtection.steps.offHelp')}
    onchange={on => onchange(on ? DEFAULT_STEPS : [])}
  />
  {#if value.length > 0}
    <ol class:invalid>
      {#each finite as step, index (index)}
        <li>
          <span class="label"
            >{t('sipProtection.steps.nth', { n: index + 1 })}</span
          >
          <DurationInput
            value={step}
            min={60}
            onchange={seconds => setFinite(index, seconds)}
          />
          <IconButton
            icon={X}
            size="sm"
            label={t('common.remove')}
            disabled={finite.length === 1 && !permanent}
            onclick={() => removeFinite(index)}
          />
        </li>
      {/each}
      {#if permanent}
        <li>
          <span class="label"
            >{t('sipProtection.steps.nth', { n: finite.length + 1 })}</span
          >
          <span class="permanent">{t('sipProtection.steps.permanent')}</span>
        </li>
      {/if}
    </ol>
    <div class="row spread">
      <Button size="sm" variant="ghost" icon={Plus} onclick={addStep}
        >{t('sipProtection.steps.add')}</Button
      >
      <Switch
        id="{id}-permanent"
        size="sm"
        checked={permanent}
        label={t('sipProtection.steps.lastPermanent')}
        onchange={on =>
          onchange(on ? [...finite, null] : finite.length > 0 ? finite : [DAY])}
      />
    </div>
  {/if}
</div>

<style>
  .steps {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
  }
  ol {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }
  ol.invalid {
    outline: 1.5px solid var(--danger);
    outline-offset: 4px;
    border-radius: var(--radius-sm);
  }
  li {
    display: grid;
    grid-template-columns: 120px 1fr 32px;
    align-items: center;
    gap: var(--space-2);
  }
  .label {
    font-size: var(--text-sm);
    font-weight: 700;
    color: var(--text-muted);
  }
  .permanent {
    font-weight: 600;
    padding: 8px 0;
  }
  @media (max-width: 480px) {
    li {
      grid-template-columns: 1fr 32px;
    }
    .label {
      grid-column: 1 / -1;
    }
  }
</style>
