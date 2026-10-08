<!--
  Find-me legs (`findMe`): external numbers rung alongside the person's devices on direct calls,
  each after its own delay; the one who answers presses 1 to accept.
-->
<script lang="ts">
  import Plus from '@lucide/svelte/icons/plus';
  import Smartphone from '@lucide/svelte/icons/smartphone';
  import Trash2 from '@lucide/svelte/icons/trash-2';

  import type { FindMeLeg } from '#lib/api/types.js';
  import { formatPhone, t } from '#lib/i18n/index.svelte.js';
  import Button from '#lib/ui/Button.svelte';
  import IconButton from '#lib/ui/IconButton.svelte';
  import NumberInput from '#lib/ui/NumberInput.svelte';
  import TextInput from '#lib/ui/TextInput.svelte';

  type Props = {
    legs: FindMeLeg[];
    onchange: (legs: FindMeLeg[]) => void;
    id?: string;
    editable?: boolean;
  };

  let { legs, onchange, id = 'findMe', editable = true }: Props = $props();

  function patch(index: number, next: Partial<FindMeLeg>): void {
    onchange(
      legs.map((leg, position) =>
        position === index ? { ...leg, ...next } : leg
      )
    );
  }
</script>

<div class="legs" {id}>
  {#if legs.length === 0}
    <p class="empty small muted">{t('people.findMe.empty')}</p>
  {/if}
  {#each legs as leg, index (index)}
    <div class="leg">
      <span class="icon" aria-hidden="true"><Smartphone size={16} /></span>
      {#if editable}
        <div class="number">
          <TextInput
            id={`${id}-${index}-number`}
            type="tel"
            mono
            placeholder="+49171 5550123"
            value={leg.number}
            oninput={number => patch(index, { number })}
          />
        </div>
        <div class="delay">
          <span class="xs muted">{t('people.findMe.after')}</span>
          <NumberInput
            id={`${id}-${index}-delay`}
            value={leg.delayS}
            min={0}
            max={86400}
            suffix="s"
            onchange={delayS => patch(index, { delayS: delayS ?? 0 })}
          />
        </div>
        <IconButton
          icon={Trash2}
          variant="danger"
          size="sm"
          label={t('common.remove')}
          onclick={() =>
            onchange(legs.filter((_, position) => position !== index))}
        />
      {:else}
        <span class="mono grow">{formatPhone(leg.number)}</span>
        <span class="small muted">
          {leg.delayS === 0
            ? t('people.findMe.immediately')
            : t('people.findMe.afterSeconds', { s: leg.delayS })}
        </span>
      {/if}
    </div>
  {/each}
  {#if editable}
    <div>
      <Button
        size="sm"
        variant="soft"
        icon={Plus}
        onclick={() => onchange([...legs, { number: '', delayS: 0 }])}
      >
        {t('people.findMe.add')}
      </Button>
    </div>
  {/if}
</div>

<style>
  .legs {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }
  .leg {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    padding: 8px 8px 8px 12px;
    background: var(--surface-2);
    border: 1px solid var(--line);
    border-radius: var(--radius-sm);
    flex-wrap: wrap;
  }
  .icon {
    display: grid;
    color: var(--text-muted);
  }
  .number {
    flex: 1 1 180px;
    min-width: 0;
  }
  .delay {
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .delay :global(.input) {
    width: 110px;
  }
  .empty {
    margin: 0;
  }
</style>
